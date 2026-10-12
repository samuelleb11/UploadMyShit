// The transfer protocol, one batch of files from one device to another.
//
// Control messages are JSON on the session's ordered `ctl` channel. File bytes are binary
// messages on the data lanes (one ordered channel per WebRTC connection; see peer.js):
//
//   DATA  [u8 1][3 pad][u32 tn][u32 file][u32 chunk] payload
//   FIN   [u8 2][3 pad][u32 tn][u32 pass][4 pad]     every byte of this pass went out on this lane
//
// Files go in order and every lane takes the next chunk, so files finish one after another
// and the receiver has each one as soon as it is complete.
//
//   sender -> receiver   offer, sent, abort
//   receiver -> sender   accept, decline, ack, resend, done, stop
//
// Flow control is the receiver's: `accept` names a window, and the sender never has more
// than that in flight or waiting for the receiver's disk. Each `ack` says how much arrived
// on each lane and how much was written, so a lane that dies takes its share of the window
// with it instead of stalling the transfer. Lanes are ordered, so a FIN proves its lane has
// delivered everything before it; when every lane has, the receiver asks again for whatever
// is still missing (lost with a lane) or says done.

import { Emitter, deferred, sleep } from './util.js';
import { Sink, download } from './sink.js';
import { safePath, uniquePaths } from './files.js';

export const HDR = 16;
export const T_DATA = 1;
export const T_FIN = 2;

/** Per lane: stay well under Chrome's 16 MB send queue, which closes the channel. */
export const LANE_HIGH = 8 << 20;
export const LANE_LOW = 4 << 20;

const READ_CHUNKS = 16; // ~4 MB per disk read
const READ_AHEAD = 32 << 20;
const MAX_READS = 6;
const ACK_EVERY = 100;
const TUNE_EVERY = 2000;
/** A connection is added only for work that will last a while yet. */
const SCALE_MIN_REMAINING = 64 << 20;
const STALL_MS = 45_000;

const TERMINAL = new Set(['done', 'declined', 'cancelled', 'failed']);

/** A sentence for the person whose transfer stopped, from whatever went wrong. */
function describeError(e) {
  const text = e?.message || String(e);
  if (/QuotaExceeded/i.test(text)) return 'not enough storage space on the receiving device';
  if (/NotAllowed|SecurityError/i.test(text)) return 'permission to write to the folder was withdrawn';
  if (/NotFound/i.test(text)) return 'the destination folder was moved or deleted';
  if (/NoModificationAllowed|InvalidState/i.test(text)) return 'a file in the destination folder is locked by another program';
  return text;
}

/** How much the receiver lets the sender have outstanding. */
export function receiveWindow() {
  const mem = navigator.deviceMemory || 8;
  return (mem <= 4 ? 32 : 64) << 20;
}

class Base extends Emitter {
  constructor(session, tn) {
    super();
    this.session = session;
    this.tn = tn;
    this.state = 'new';
    this.error = null;
    this.speed = 0;
    this.filesDone = 0;
    this.createdAt = Date.now();
  }

  get terminal() {
    return TERMINAL.has(this.state);
  }

  _set(state, error = null) {
    if (this.terminal) return false;
    this.state = state;
    if (error) this.error = error;
    if (TERMINAL.has(state)) this.endedAt = performance.now();
    this.emit('state', state);
    this.emit('change');
    return true;
  }

  get eta() {
    const left = this.total - this.written;
    return this.speed > 0 && left > 0 ? left / this.speed : null;
  }

  _startSpeed(get) {
    let last = get();
    let at = performance.now();
    this.speedTimer = setInterval(() => {
      const now = performance.now();
      const v = get();
      const inst = ((v - last) / (now - at)) * 1000;
      this.speed = this.speed ? this.speed * 0.6 + inst * 0.4 : inst;
      last = v;
      at = now;
      this.emit('change');
    }, 500);
  }

  _stopTimers() {
    clearInterval(this.speedTimer);
    clearInterval(this.tuneTimer);
    clearInterval(this.ackTimer);
  }
}

/** Reads files ahead of the network, several reads in flight, into ready-to-send chunks. */
class ChunkReader {
  constructor(files, chunk, tn) {
    this.files = files;
    this.chunk = chunk;
    this.tn = tn;
    this.fi = 0;
    this.ci = 0;
    this.ranges = [];
    this.ready = [];
    this.readyBytes = 0;
    this.pendingBytes = 0;
    this.reads = 0;
    this.waiter = null;
    this.error = null;
    this.#skipEmpty();
  }

  #skipEmpty() {
    while (this.fi < this.files.length && this.ci * this.chunk >= this.files[this.fi].file.size) {
      this.fi++;
      this.ci = 0;
    }
  }

  #nextBlock() {
    while (this.ranges.length) {
      const r = this.ranges[0];
      if (r[1] >= r[2]) {
        this.ranges.shift();
        continue;
      }
      const n = Math.min(READ_CHUNKS, r[2] - r[1]);
      const block = { fi: r[0], ci: r[1], n };
      r[1] += n;
      return block;
    }
    if (this.fi >= this.files.length) return null;
    const total = Math.ceil(this.files[this.fi].file.size / this.chunk);
    const n = Math.min(READ_CHUNKS, total - this.ci);
    const block = { fi: this.fi, ci: this.ci, n };
    this.ci += n;
    this.#skipEmpty();
    return block;
  }

  #fill() {
    while (!this.error && this.reads < MAX_READS && this.readyBytes + this.pendingBytes < READ_AHEAD) {
      const b = this.#nextBlock();
      if (!b) break;
      const size = this.files[b.fi].file.size;
      b.start = b.ci * this.chunk;
      b.end = Math.min(size, b.start + b.n * this.chunk);
      this.reads++;
      this.pendingBytes += b.end - b.start;
      this.#read(b);
    }
  }

  async #read(b) {
    try {
      const ab = await this.files[b.fi].file.slice(b.start, b.end).arrayBuffer();
      if (ab.byteLength !== b.end - b.start) throw new Error('the file changed while it was being sent');
      const src = new Uint8Array(ab);
      for (let i = 0, off = 0; off < src.length; i++, off += this.chunk) {
        const len = Math.min(this.chunk, src.length - off);
        const buf = new ArrayBuffer(HDR + len);
        const dv = new DataView(buf);
        dv.setUint8(0, T_DATA);
        dv.setUint32(4, this.tn);
        dv.setUint32(8, b.fi);
        dv.setUint32(12, b.ci + i);
        new Uint8Array(buf, HDR).set(src.subarray(off, off + len));
        this.ready.push({ buf, len });
        this.readyBytes += len;
      }
    } catch (e) {
      this.error = new Error(`Could not read ${this.files[b.fi].path}: ${e.message}`);
    }
    this.reads--;
    this.pendingBytes -= b.end - b.start;
    const w = this.waiter;
    this.waiter = null;
    w?.();
    this.#fill();
  }

  take() {
    if (this.error) throw this.error;
    this.#fill();
    const item = this.ready.shift();
    if (!item) return null;
    this.readyBytes -= item.len;
    return item;
  }

  async next() {
    for (;;) {
      const item = this.take();
      if (item) return item;
      if (this.exhausted()) return null;
      await new Promise((r) => (this.waiter = r));
    }
  }

  exhausted() {
    return !this.ready.length && !this.reads && this.fi >= this.files.length && !this.ranges.some((r) => r[1] < r[2]);
  }

  unshift(item) {
    this.ready.unshift(item);
    this.readyBytes += item.len;
  }

  requeue(ranges) {
    for (const [fi, c0, c1] of ranges) this.ranges.push([fi, c0, c1]);
  }
}

export class OutgoingTransfer extends Base {
  constructor(session, tn, files, dirs, limiter, settings) {
    super(session, tn);
    this.direction = 'out';
    this.files = files;
    this.dirs = dirs;
    this.limiter = limiter;
    this.settings = settings;
    this.count = files.length;
    this.total = files.reduce((a, f) => a + f.file.size, 0);
    this.state = 'queued';
    this.sentByLane = new Map();
    this.ackR = {};
    this.ackW = 0;
    this.recv = 0;
    this.written = 0;
    this.lastProgress = performance.now();
    this.waits = { window: 0, lane: 0, read: 0, limit: 0 };
    /** The same, never reset: where the time went, for diagnostics. */
    this.waitTotals = { window: 0, lane: 0, read: 0, limit: 0 };
    this.ackWaiters = [];
    this.reply = deferred();
    this.verdict = null;
    this.pass = 0;
  }

  get lanes() {
    return this.session.openLanes().length;
  }

  /** Runs the whole transfer; resolves when it ends however it ends. */
  async run() {
    if (this.terminal) return;
    const s = this.session;
    this.chunk = s.chunkSize();
    this._set('offered');
    await s.sendCtl({
      t: 'offer',
      tn: this.tn,
      chunk: this.chunk,
      total: this.total,
      files: this.files.map((f) => ({ p: f.path, s: f.file.size, m: f.file.lastModified || 0, y: f.file.type || '' })),
      dirs: this.dirs,
    });
    const reply = await this.reply.promise;
    if (reply.t === 'decline') {
      this._set('declined');
      return;
    }
    this.window = Math.min(256 << 20, Math.max(4 << 20, Number(reply.window) || 32 << 20));
    this._set('sending');
    this.startedAt = performance.now();
    this.lastProgress = performance.now();
    this.reader = new ChunkReader(this.files, this.chunk, this.tn);
    this._startSpeed(() => this.recv);
    this.tuneAt = performance.now();
    this.tuneRecv = 0;
    this.tuneTimer = setInterval(() => this.#tune(), TUNE_EVERY);
    this.#tune();
    try {
      await this.#pump();
      this.written = this.total;
      this.filesDone = this.count;
      this._set('done');
    } finally {
      this._stopTimers();
    }
  }

  #alive() {
    if (this.terminal) throw new Error(this.error || this.state);
    if (performance.now() - this.lastProgress > STALL_MS) {
      throw new Error('the other device stopped responding');
    }
  }

  async #pump() {
    const s = this.session;
    for (;;) {
      this.#alive();
      let item = this.reader.take();
      if (!item) {
        if (this.reader.exhausted()) {
          const verdict = await this.#endPass();
          if (verdict.t === 'done') return;
          this.reader.requeue(verdict.ranges);
          continue;
        }
        const t0 = performance.now();
        item = await this.reader.next();
        this.waits.read += performance.now() - t0;
        if (!item) continue;
      }
      if (this.#inflight() + item.len > this.window) {
        const t0 = performance.now();
        while (this.#inflight() + item.len > this.window) {
          this.#alive();
          await this.#waitAck();
        }
        this.waits.window += performance.now() - t0;
      }
      if (this.limiter.rate) {
        const t0 = performance.now();
        await this.limiter.take(item.len);
        this.waits.limit += performance.now() - t0;
      }
      let lane = this.#pickLane();
      if (!lane) {
        const t0 = performance.now();
        while (!(lane = this.#pickLane())) {
          this.#alive();
          await s.waitDrain(250);
        }
        this.waits.lane += performance.now() - t0;
      }
      try {
        lane.send(item.buf);
      } catch {
        // The lane closed under us; the chunk goes out on another.
        this.reader.unshift(item);
        await sleep(20);
        continue;
      }
      this.sentByLane.set(lane.lid, (this.sentByLane.get(lane.lid) || 0) + item.len);
    }
  }

  /**
   * The lane that will have this chunk on its way soonest: least queued for its measured
   * rate, among lanes under their own queue limit. A lane not measured yet is assumed
   * quick, so a new one gets tried. Null when every lane is full.
   */
  #pickLane() {
    let best = null;
    let bestTime = Infinity;
    for (const l of this.session.openLanes()) {
      const queued = l.buffered;
      if (queued >= (l.high ?? LANE_HIGH)) continue;
      const time = (queued + 1) / (l.rate || 50e6);
      if (time < bestTime) {
        best = l;
        bestTime = time;
      }
    }
    return best;
  }

  /** Bytes on live lanes not yet received, plus bytes received but not yet written. */
  #inflight() {
    let net = 0;
    let recvAll = 0;
    for (const [lid, sent] of this.sentByLane) {
      if (this.session.laneOpen(lid)) net += sent - (this.ackR[lid] || 0);
    }
    for (const lid in this.ackR) recvAll += this.ackR[lid];
    return net + Math.max(0, recvAll - this.ackW);
  }

  #waitAck() {
    return new Promise((resolve) => {
      this.ackWaiters.push(resolve);
      // Re-check now and then anyway: a lane closing frees its share without an ack.
      setTimeout(resolve, 250);
    });
  }

  #wakeAck() {
    const w = this.ackWaiters;
    this.ackWaiters = [];
    for (const r of w) r();
  }

  async #endPass() {
    const s = this.session;
    const lanes = s.openLanes();
    const fin = new ArrayBuffer(HDR);
    const dv = new DataView(fin);
    dv.setUint8(0, T_FIN);
    dv.setUint32(4, this.tn);
    dv.setUint32(8, this.pass);
    for (const l of lanes) {
      try {
        l.send(fin.slice(0));
      } catch {
        /* closed; the receiver stops waiting for it */
      }
    }
    this._set('verifying');
    this.verdict = deferred();
    await s.sendCtl({ t: 'sent', tn: this.tn, pass: this.pass, lanes: lanes.map((l) => l.lid) });
    // The receiver may take a while to close its last file; its acks keep this alive.
    const v = await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          this.#alive();
        } catch (e) {
          clearInterval(timer);
          reject(e);
        }
      }, 1000);
      this.verdict.promise.then(
        (x) => (clearInterval(timer), resolve(x)),
        (e) => (clearInterval(timer), reject(e)),
      );
    });
    this.pass++;
    if (v.t === 'resend') {
      this.state = 'sending';
      this.emit('change');
    }
    return v;
  }

  /**
   * Adds lanes while that helps: another WebRTC connection (more congestion windows and send
   * queues, which a long or fast path needs) or a relay lane (a separate route entirely).
   * Grow only while the lanes are the bottleneck (not the receiver's disk, not our reads,
   * not the user's cap), and stop trying a kind once an addition of it fails to raise the
   * rate by 10%. A relay lane that did not help is closed again, unless it carries the
   * control messages.
   */
  #tune() {
    const s = this.session;
    const now = performance.now();
    const dt = now - this.tuneAt;
    const rate = ((this.recv - this.tuneRecv) / dt) * 1000;
    const frac = (k) => this.waits[k] / dt;
    const laneBound = frac('lane') > 0.5 && frac('window') < 0.25 && frac('read') < 0.25 && frac('limit') < 0.1;
    this.tuneAt = now;
    this.tuneRecv = this.recv;
    for (const k in this.waits) {
      this.waitTotals[k] += this.waits[k];
      this.waits[k] = 0;
    }
    if (this.state !== 'sending' || s.growing) return;

    if (this.pendingEval) {
      if (now < this.pendingEval.at) return;
      const { base, kind, lane } = this.pendingEval;
      this.pendingEval = null;
      if (rate < base * 1.1) {
        if (kind === 'rtc') s.saturatedRtc = true;
        else {
          s.saturatedRelay = true;
          if (lane && s.openLanes().some((l) => l.kind === 'rtc')) s.closeRelayLane(lane);
        }
      }
      return;
    }

    const remaining = this.total - this.recv;
    if (remaining < SCALE_MIN_REMAINING) return;
    // A fixed WebRTC connection count: open them all as soon as there is enough to send.
    if (this.settings.maxLinks !== 'auto' && s.ctlReady() && s.path && s.path !== 'turn' && s.linkCount() < s.targetLinks()) {
      s.addLink()
        .then(() => this.#tune())
        .catch(() => {});
      return;
    }
    if (!laneBound || remaining < rate * 8) return;
    const kind = s.nextGrowth();
    if (!kind) return;
    (kind === 'rtc' ? s.addLink() : s.addRelayLane())
      .then((lane) => {
        this.pendingEval = { base: rate, kind, lane, at: performance.now() + 3000 };
      })
      .catch(() => {
        if (kind === 'rtc') s.saturatedRtc = true;
        else s.saturatedRelay = true;
      });
  }

  onCtl(m) {
    switch (m.t) {
      case 'accept':
      case 'decline':
        this.reply.resolve(m);
        break;
      case 'ack': {
        // Acks may come by either path and overtake each other: every count only grows.
        if (m.r && typeof m.r === 'object') {
          for (const lid in m.r) this.ackR[lid] = Math.max(this.ackR[lid] || 0, Number(m.r[lid]) || 0);
        }
        this.ackW = Math.max(this.ackW, Number(m.w) || 0);
        this.lastProgress = performance.now();
        this.recv = Math.max(this.recv, Number(m.u) || 0);
        this.written = Math.max(this.written, Number(m.d) || 0);
        this.filesDone = Math.max(this.filesDone, Number(m.f) || 0);
        this.#wakeAck();
        this.emit('change');
        break;
      }
      case 'resend':
        if (this.verdict && m.pass === this.pass && Array.isArray(m.ranges)) {
          const ok = m.ranges.every(
            (r) =>
              Array.isArray(r) &&
              this.files[r[0]] &&
              Number.isInteger(r[1]) &&
              Number.isInteger(r[2]) &&
              r[1] >= 0 &&
              r[2] <= Math.ceil(this.files[r[0]].file.size / this.chunk),
          );
          if (ok) this.verdict.resolve(m);
        }
        break;
      case 'done':
        this.lastProgress = performance.now();
        this.verdict?.resolve(m);
        break;
      case 'stop':
        if (m.reason) this.#end('failed', `The receiver stopped: ${String(m.reason).slice(0, 300)}`);
        else this.#end('cancelled', 'Stopped by the receiver');
        break;
    }
  }

  #end(state, error) {
    if (!this._set(state, error)) return;
    this._stopTimers();
    const err = new Error(error || state);
    this.reply.reject(err);
    this.verdict?.reject(err);
    this.#wakeAck();
    this.session.wakeDrain();
  }

  /** Stops sending. Before it started, it simply leaves the queue. */
  cancel() {
    if (this.terminal) return;
    if (this.state !== 'queued') this.session.sendCtl({ t: 'abort', tn: this.tn }).catch(() => {});
    this.#end('cancelled', 'Cancelled');
  }

  fail(err) {
    if (this.terminal) return;
    this.session.sendCtl({ t: 'abort', tn: this.tn }).catch(() => {});
    this.#end('failed', err?.message || String(err));
  }

  onSessionClosed(reason) {
    this.#end('failed', reason);
  }
}

export class IncomingTransfer extends Base {
  /** Throws on an offer that does not describe a real batch of files. */
  static validate(m) {
    const ok =
      Number.isInteger(m.tn) &&
      Number.isInteger(m.chunk) &&
      m.chunk >= 4096 &&
      m.chunk <= 1 << 20 &&
      Array.isArray(m.files) &&
      m.files.length <= 1_000_000 &&
      m.files.every((f) => f && typeof f.p === 'string' && Number.isSafeInteger(f.s) && f.s >= 0) &&
      (m.dirs === undefined || (Array.isArray(m.dirs) && m.dirs.every((d) => typeof d === 'string')));
    if (!ok) throw new Error('malformed offer');
  }

  constructor(session, offer) {
    super(session, offer.tn);
    this.direction = 'in';
    this.chunk = offer.chunk;
    const named = uniquePaths({
      files: offer.files.map((f) => ({ path: safePath(f.p), size: f.s, mtime: f.m, type: typeof f.y === 'string' ? f.y : '' })),
      dirs: (offer.dirs ?? []).map(safePath),
    });
    this.files = named.files;
    this.dirs = named.dirs;
    this.count = this.files.length;
    this.total = this.files.reduce((a, f) => a + f.size, 0);
    this.state = 'pending';
    this.recvByLane = {};
    this.dup = 0;
    this.recv = 0;
    this.written = 0;
    this.fins = new Map();
    this.sentInfo = null;
    this.completed = [];
  }

  get lanes() {
    return this.session.openLanes().length;
  }

  /**
   * opts: { mode: 'dir', dir } to stream into a folder, or { mode: 'opfs' | 'mem' } to
   * hand each finished file to the browser's downloads.
   */
  async accept(opts) {
    if (this.state !== 'pending') return;
    this._set('accepting');
    try {
      this.sink = new Sink();
      this.sink.onWritten = (n) => {
        this.written = n;
      };
      this.sink.onFile = (m) => this.#onFile(m);
      this.sink.onError = (e) => this.#fail(e);
      const info = await this.sink.init({
        mode: opts.mode,
        dir: opts.dir,
        files: this.files.map((f) => ({ p: f.path, s: f.size, y: f.type })),
        dirs: this.dirs,
        chunk: this.chunk,
      });
      this.mode = opts.mode;
      this.destination = opts.dir?.name ?? null;
      this.savedPaths = info.paths;
      this.bitmaps = this.files.map((f) => new Uint8Array(Math.ceil(f.size / this.chunk)));
      this.remaining = this.bitmaps.reduce((a, b) => a + b.length, 0);
      if (this.terminal) return;
      this._set('receiving');
      this.startedAt = performance.now();
      await this.session.sendCtl({ t: 'accept', tn: this.tn, window: receiveWindow() });
      this._startSpeed(() => this.recv);
      let lastSent = '';
      let lastAt = 0;
      this.ackTimer = setInterval(() => {
        const ack = { t: 'ack', tn: this.tn, r: this.recvByLane, w: this.written + this.dup, u: this.recv, d: this.written, f: this.filesDone };
        const key = `${ack.w}/${ack.u}/${ack.f}`;
        // Unchanged acks still go every 2 s: they are how the sender knows this side lives.
        if (key === lastSent && performance.now() - lastAt < 2000) return;
        lastSent = key;
        lastAt = performance.now();
        this.session.sendCtl(ack).catch(() => {});
      }, ACK_EVERY);
    } catch (e) {
      this.#fail(e);
      throw e;
    }
  }

  async decline() {
    if (this.state !== 'pending') return;
    this._set('declined');
    await this.session.sendCtl({ t: 'decline', tn: this.tn }).catch(() => {});
  }

  #chunkLen(fi, ci) {
    return Math.min(this.chunk, this.files[fi].size - ci * this.chunk);
  }

  onData(link, buf) {
    if (this.state !== 'receiving') return;
    const dv = new DataView(buf);
    const type = dv.getUint8(0);
    if (type === T_DATA) {
      const len = buf.byteLength - HDR;
      this.recvByLane[link.lid] = (this.recvByLane[link.lid] || 0) + len;
      const fi = dv.getUint32(8);
      const ci = dv.getUint32(12);
      const bm = this.bitmaps[fi];
      if (!bm || ci >= bm.length || bm[ci] || len !== this.#chunkLen(fi, ci)) {
        this.dup += len;
        return;
      }
      bm[ci] = 1;
      this.recv += len;
      this.remaining--;
      this.sink.write(fi, ci, buf);
    } else if (type === T_FIN) {
      const pass = dv.getUint32(8);
      if (!this.fins.has(pass)) this.fins.set(pass, new Set());
      this.fins.get(pass).add(link.lid);
      this.#check();
    }
  }

  onLanesChanged() {
    this.#check();
  }

  onCtl(m) {
    if (m.t === 'sent' && Array.isArray(m.lanes)) {
      this.sentInfo = m;
      this.#check();
    } else if (m.t === 'abort') {
      this.#end('cancelled', 'Cancelled by the sender');
    }
  }

  /** At the end of a pass: done, or ask for what never arrived. */
  #check() {
    const info = this.sentInfo;
    if (!info || this.state !== 'receiving') return;
    const fins = this.fins.get(info.pass) ?? new Set();
    const open = new Set(this.session.openLanes().map((l) => l.lid));
    if (!info.lanes.every((lid) => fins.has(lid) || !open.has(lid))) return;
    this.sentInfo = null;
    if (this.remaining === 0) {
      this.#complete();
      return;
    }
    const ranges = [];
    this.bitmaps.forEach((bm, fi) => {
      for (let i = 0; i < bm.length; i++) {
        if (bm[i]) continue;
        let j = i;
        while (j < bm.length && !bm[j]) j++;
        ranges.push([fi, i, j]);
        i = j;
      }
    });
    this.session.sendCtl({ t: 'resend', tn: this.tn, pass: info.pass, ranges }).catch(() => {});
  }

  #onFile(m) {
    this.filesDone++;
    const entry = { fi: m.fi, path: m.path, size: this.files[m.fi].size, blob: m.blob };
    this.completed.push(entry);
    if (m.blob && this.mode !== 'dir') download(m.blob, m.path);
    this.emit('file', entry);
    this.emit('change');
  }

  async #complete() {
    this._set('finishing');
    try {
      await this.sink.finish();
    } catch (e) {
      this.#fail(e);
      return;
    }
    clearInterval(this.ackTimer);
    await this.session
      .sendCtl({ t: 'ack', tn: this.tn, r: this.recvByLane, w: this.written + this.dup, u: this.recv, d: this.written, f: this.filesDone })
      .catch(() => {});
    await this.session.sendCtl({ t: 'done', tn: this.tn }).catch(() => {});
    this._stopTimers();
    this._set('done');
  }

  #end(state, error) {
    if (!this._set(state, error)) return;
    this._stopTimers();
    this.sink?.abort();
  }

  #fail(e) {
    if (this.terminal) return;
    const reason = describeError(e);
    this.session.sendCtl({ t: 'stop', tn: this.tn, reason }).catch(() => {});
    this.#end('failed', reason);
  }

  cancel() {
    if (this.terminal) return;
    if (this.state === 'pending') {
      this.decline();
      return;
    }
    this.session.sendCtl({ t: 'stop', tn: this.tn }).catch(() => {});
    this.#end('cancelled', 'Cancelled');
  }

  onSessionClosed(reason) {
    if (this.state === 'pending') this._set('cancelled', reason);
    else this.#end('failed', reason);
  }

  /** Lets private storage go once the user is done with the downloads. */
  release() {
    this.sink?.release();
  }
}
