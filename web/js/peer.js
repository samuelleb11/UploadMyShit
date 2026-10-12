// One other device: the WebRTC connections to it and the transfers in both directions.
//
// The first connection is negotiated through the signaling server ("perfect negotiation":
// either side may start, and a collision resolves itself). It carries the `ctl` channel and
// a data lane. Further connections, opened while a large transfer benefits from them, are
// negotiated over `ctl` itself, browser to browser, so the server sees only the first.
// Every channel is pre-negotiated (fixed ids on both sides), so neither side waits for the
// other to announce one.

import { Emitter, deferred, withTimeout } from './util.js';
import { HDR, LANE_LOW, IncomingTransfer, OutgoingTransfer } from './transfer.js';

const CTL_ID = 0;
const DATA_ID = 1;
const CTL_FRAGMENT = 16_000;
const CTL_HIGH = 1 << 20;
const CONNECT_TIMEOUT = 25_000;
/** Most connections to one device, whatever the settings say. */
export const MAX_LINKS = 8;
const AUTO_LINKS = 4;

export class PeerSession extends Emitter {
  constructor({ localId, remoteId, signaling, getIce, settings, limiter }) {
    super();
    this.localId = localId;
    this.remoteId = remoteId;
    this.signaling = signaling;
    this.getIce = getIce;
    this.settings = settings;
    this.limiter = limiter;
    // The polite side yields when both offer at once.
    this.polite = localId < remoteId;
    this.links = new Map();
    this.ctl = null;
    this.state = 'idle';
    this.path = null;
    this.saturated = false;
    this.linkSeq = 0;
    this.linkPending = 0;
    this.outgoing = new Map();
    this.incoming = new Map();
    this.queue = [];
    this.active = null;
    this.tnSeq = 0;
    this.frags = new Map();
    this.fragSeq = 0;
    this.drainWaiters = [];
    this.sigChain = Promise.resolve();
    this.linkChain = Promise.resolve();
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.restarts = 0;
    this.connected = deferred();
  }

  // ---- the main connection ---------------------------------------------------------

  /** Connects if not already; resolves once the control channel is open. */
  connect() {
    this.#main();
    return this.connected.promise;
  }

  #main() {
    if (!this.mainPromise) {
      this.mainPromise = this.#createMain();
      this.mainPromise.catch((e) => this.close(e.message));
    }
    return this.mainPromise;
  }

  async #createMain() {
    this.state = 'connecting';
    this.emit('state');
    this.rtcConfig = { ...(await this.getIce()), bundlePolicy: 'max-bundle' };
    const pc = new RTCPeerConnection(this.rtcConfig);
    const ctl = pc.createDataChannel('ctl', { negotiated: true, id: CTL_ID, ordered: true });
    const dc = pc.createDataChannel('data', { negotiated: true, id: DATA_ID, ordered: true });
    this.main = pc;
    this.#setupCtl(ctl);
    this.#addLink('0', pc, dc);
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.#signal({ k: 'sdp', d: pc.localDescription });
      } catch (e) {
        console.warn('negotiation failed', e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.#signal({ k: 'ice', c: candidate });
    };
    pc.onconnectionstatechange = () => this.#onMainState();
    this.connectTimer = setTimeout(() => {
      if (this.state === 'connecting') this.close(this.#noRouteMessage());
    }, CONNECT_TIMEOUT);
    return pc;
  }

  #noRouteMessage() {
    const relay = (this.rtcConfig?.iceServers ?? []).some((s) => [].concat(s.urls).some((u) => u.startsWith('turn')));
    return relay
      ? 'Could not connect to this device'
      : 'Could not connect: the networks block a direct connection and no relay is configured';
  }

  #signal(data) {
    this.signaling.signal(this.remoteId, data);
  }

  /** Negotiation from the signaling server, handled strictly in arrival order. */
  handleSignal(data) {
    this.sigChain = this.sigChain.then(() => this.#handleSignal(data)).catch((e) => console.warn('signal', e));
  }

  async #handleSignal(data) {
    if (this.state === 'closed') return;
    const pc = await this.#main();
    if (data.k === 'sdp') {
      const d = data.d;
      const collision = d.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        await pc.setLocalDescription();
        this.#signal({ k: 'sdp', d: pc.localDescription });
      }
    } else if (data.k === 'ice') {
      try {
        await pc.addIceCandidate(data.c);
      } catch (e) {
        if (!this.ignoreOffer) console.warn('candidate refused', e);
      }
    }
  }

  #onMainState() {
    const s = this.main.connectionState;
    if (s === 'connected') {
      this.restarts = 0;
      this.#detectPath();
      setTimeout(() => this.#detectPath(), 3000);
    } else if (s === 'failed') {
      // A network change: try new candidates over the same DTLS/SCTP association, which
      // lets transfers in progress carry on.
      if (this.ctl && this.restarts < 2) {
        this.restarts++;
        this.main.restartIce();
      } else {
        this.close(this.ctl ? 'Connection lost' : this.#noRouteMessage());
      }
    } else if (s === 'closed') {
      this.close('Connection closed');
    }
  }

  async #detectPath() {
    try {
      const stats = await this.main.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!pair) {
        stats.forEach((r) => {
          if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
        });
      }
      if (!pair) return;
      const types = [stats.get(pair.localCandidateId)?.candidateType, stats.get(pair.remoteCandidateId)?.candidateType];
      this.path = types.includes('relay') ? 'relay' : types.every((t) => t === 'host') ? 'lan' : 'direct';
      this.rtt = pair.currentRoundTripTime;
      this.emit('path', this.path);
      this.emit('state');
    } catch {
      /* closed meanwhile */
    }
  }

  // ---- control channel -------------------------------------------------------------

  #setupCtl(ctl) {
    ctl.bufferedAmountLowThreshold = CTL_HIGH / 4;
    ctl.onopen = () => {
      clearTimeout(this.connectTimer);
      this.ctl = ctl;
      this.state = 'connected';
      this.connected.resolve();
      this.emit('state');
    };
    ctl.onmessage = (e) => this.#onCtlText(e.data);
    ctl.onclose = () => this.close('Connection closed');
  }

  /** Sends one control message, split into fragments when it is large (a big offer). */
  async sendCtl(obj) {
    const s = JSON.stringify(obj);
    if (s.length <= CTL_FRAGMENT) return this.#ctlSend(s);
    const id = ++this.fragSeq;
    const n = Math.ceil(s.length / CTL_FRAGMENT);
    for (let i = 0; i < n; i++) {
      await this.#ctlSend(JSON.stringify({ t: 'frag', id, i, n, d: s.slice(i * CTL_FRAGMENT, (i + 1) * CTL_FRAGMENT) }));
    }
  }

  async #ctlSend(s) {
    const ctl = this.ctl;
    if (!ctl || ctl.readyState !== 'open') throw new Error('not connected');
    while (ctl.bufferedAmount > CTL_HIGH && ctl.readyState === 'open') {
      await new Promise((r) => {
        ctl.addEventListener('bufferedamountlow', r, { once: true });
        ctl.addEventListener('close', r, { once: true });
      });
    }
    ctl.send(s);
  }

  #onCtlText(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.t === 'frag') {
      let f = this.frags.get(m.id);
      if (!f) {
        if (!(m.n > 0 && m.n < 20_000)) return;
        f = { parts: new Array(m.n), got: 0 };
        this.frags.set(m.id, f);
      }
      if (f.parts[m.i] === undefined && typeof m.d === 'string') {
        f.parts[m.i] = m.d;
        f.got++;
      }
      if (f.got === f.parts.length) {
        this.frags.delete(m.id);
        this.#onCtlText(f.parts.join(''));
      }
      return;
    }
    this.#dispatch(m);
  }

  #dispatch(m) {
    switch (m.t) {
      case 'link':
        this.linkChain = this.linkChain.then(() => this.#onLink(m)).catch((e) => console.warn('link', e));
        break;
      case 'offer':
        this.#onOffer(m);
        break;
      case 'sent':
      case 'abort':
        this.incoming.get(m.tn)?.onCtl(m);
        break;
      case 'accept':
      case 'decline':
      case 'ack':
      case 'resend':
      case 'done':
      case 'stop':
        this.outgoing.get(m.tn)?.onCtl(m);
        break;
    }
  }

  // ---- lanes -------------------------------------------------------------------------

  #addLink(lid, pc, dc) {
    const link = { lid, pc, dc, open: false, opened: deferred(), pendingCands: [] };
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LANE_LOW;
    dc.onopen = () => {
      link.open = true;
      link.opened.resolve();
      this.#lanesChanged();
    };
    dc.onclose = () => {
      link.open = false;
      this.links.delete(lid);
      if (lid !== '0') {
        try {
          pc.close();
        } catch {
          /* already closed */
        }
      }
      this.#lanesChanged();
    };
    dc.onbufferedamountlow = () => this.wakeDrain();
    dc.onmessage = (e) => this.#onData(link, e.data);
    this.links.set(lid, link);
    return link;
  }

  openLanes() {
    const out = [];
    for (const l of this.links.values()) if (l.open && l.dc.readyState === 'open') out.push(l);
    return out;
  }

  linkCount() {
    return this.links.size;
  }

  /** How many connections the settings allow to this device. */
  targetLinks() {
    const s = this.settings.maxLinks;
    return s === 'auto' ? AUTO_LINKS : Math.max(1, Math.min(MAX_LINKS, Number(s) || 1));
  }

  wakeDrain() {
    const w = this.drainWaiters;
    this.drainWaiters = [];
    for (const r of w) r();
  }

  /** Resolves when a lane has room again, its set changes, or after `ms` at most. */
  waitDrain(ms = 250) {
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
      setTimeout(resolve, ms);
    });
  }

  #lanesChanged() {
    this.wakeDrain();
    for (const t of this.incoming.values()) t.onLanesChanged();
    this.emit('lanes');
    this.emit('state');
  }

  #onData(link, buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < HDR) return;
    const tn = new DataView(buf).getUint32(4);
    this.incoming.get(tn)?.onData(link, buf);
  }

  /** Opens one more connection to this device, negotiated over `ctl`. */
  async addLink() {
    if (this.links.size >= MAX_LINKS) throw new Error('enough connections');
    const lid = `${this.polite ? 'p' : 'q'}${++this.linkSeq}`;
    this.linkPending++;
    try {
      const pc = new RTCPeerConnection(this.rtcConfig);
      const dc = pc.createDataChannel('data', { negotiated: true, id: DATA_ID, ordered: true });
      const link = this.#addLink(lid, pc, dc);
      this.#wireLink(link);
      await pc.setLocalDescription(await pc.createOffer());
      await this.sendCtl({ t: 'link', op: 'offer', lid, sdp: pc.localDescription });
      await withTimeout(link.opened.promise, 15_000, 'the extra connection did not open');
      return link;
    } catch (e) {
      this.#closeLink(lid, true);
      throw e;
    } finally {
      this.linkPending--;
      this.emit('state');
    }
  }

  #wireLink(link) {
    link.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendCtl({ t: 'link', op: 'cand', lid: link.lid, c: candidate }).catch(() => {});
    };
    link.pc.onconnectionstatechange = () => {
      if (link.pc.connectionState === 'failed') this.#closeLink(link.lid, true);
    };
  }

  async #onLink(m) {
    if (typeof m.lid !== 'string' || m.lid === '0' || m.lid.length > 16) return;
    let link = this.links.get(m.lid);
    if (m.op === 'offer') {
      if (link || this.links.size >= MAX_LINKS) return;
      const pc = new RTCPeerConnection(this.rtcConfig);
      const dc = pc.createDataChannel('data', { negotiated: true, id: DATA_ID, ordered: true });
      link = this.#addLink(m.lid, pc, dc);
      this.#wireLink(link);
      await pc.setRemoteDescription(m.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await this.sendCtl({ t: 'link', op: 'answer', lid: m.lid, sdp: pc.localDescription });
      this.#flushCands(link);
    } else if (m.op === 'answer' && link) {
      await link.pc.setRemoteDescription(m.sdp);
      this.#flushCands(link);
    } else if (m.op === 'cand' && link) {
      if (link.pc.remoteDescription) await link.pc.addIceCandidate(m.c).catch(() => {});
      else link.pendingCands.push(m.c);
    } else if (m.op === 'close') {
      this.#closeLink(m.lid, false);
    }
  }

  #flushCands(link) {
    for (const c of link.pendingCands.splice(0)) link.pc.addIceCandidate(c).catch(() => {});
  }

  #closeLink(lid, tell) {
    const link = this.links.get(lid);
    if (!link || lid === '0') return;
    this.links.delete(lid);
    try {
      link.pc.close();
    } catch {
      /* already closed */
    }
    if (tell) this.sendCtl({ t: 'link', op: 'close', lid }).catch(() => {});
    this.#lanesChanged();
  }

  /** The payload size of one chunk: as large as both browsers accept, at most 256 KB. */
  chunkSize() {
    const max = this.main?.sctp?.maxMessageSize || 65_536;
    const message = Math.min(max, 256 * 1024);
    // 4 KB multiples keep disk writes aligned.
    return Math.max(4096, Math.floor((message - HDR) / 4096) * 4096);
  }

  // ---- transfers ---------------------------------------------------------------------

  /** Queues files for this device; transfers to one device run one after another. */
  send(files, dirs = []) {
    const t = new OutgoingTransfer(this, ++this.tnSeq, files, dirs, this.limiter, this.settings);
    this.outgoing.set(t.tn, t);
    this.queue.push(t);
    t.on('state', () => {
      if (t.terminal) this.queue = this.queue.filter((q) => q !== t);
    });
    this.emit('transfer', t);
    this.#next();
    return t;
  }

  async #next() {
    if (this.active || !this.queue.length || this.state === 'closed') return;
    const t = (this.active = this.queue.shift());
    try {
      await this.connect();
      await t.run();
    } catch (e) {
      t.fail(e);
    } finally {
      this.active = null;
      this.#next();
    }
  }

  #onOffer(m) {
    try {
      IncomingTransfer.validate(m);
    } catch {
      return;
    }
    if (this.incoming.has(m.tn)) return;
    const t = new IncomingTransfer(this, m);
    this.incoming.set(m.tn, t);
    this.emit('transfer', t);
    this.emit('offer', t);
  }

  get busy() {
    const active = (t) => !t.terminal;
    return [...this.outgoing.values()].some(active) || [...this.incoming.values()].some(active);
  }

  close(reason = 'Closed') {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closeReason = reason;
    clearTimeout(this.connectTimer);
    for (const t of [...this.outgoing.values(), ...this.incoming.values()]) t.onSessionClosed(reason);
    for (const l of this.links.values()) {
      try {
        l.pc.close();
      } catch {
        /* already closed */
      }
    }
    this.links.clear();
    this.wakeDrain();
    this.connected.reject(new Error(reason));
    this.emit('state');
    this.emit('closed', reason);
  }
}

