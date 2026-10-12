// One other device: the connections to it and the transfers in both directions.
//
// Two ways to reach it, used together when both help:
//
// - WebRTC, browser to browser. The first connection is negotiated through the signaling
//   server ("perfect negotiation": either side may start, and a collision resolves itself);
//   it carries the `ctl` channel and a data lane. Extra connections, opened while a large
//   transfer benefits from them, are negotiated over `ctl` itself. Every channel is
//   pre-negotiated (fixed ids on both sides), so neither side waits for the other to
//   announce one.
// - The relay Worker (relay.js): WebSocket lanes, encrypted end to end. Used when no direct
//   connection opens within a few seconds, and added beside a direct one while a transfer is
//   limited by its lanes and the relay raises the rate.
//
// Control messages go over WebRTC while it is direct, over the relay otherwise. Every lane,
// of either kind, has the same face for the transfer code: send(), buffered, ready, and a
// measured drain rate the sender uses to keep each lane's queue about as deep as it drains
// in under a second.

import { Emitter, deferred, randomToken, withTimeout } from './util.js';
import { HDR, LANE_HIGH, LANE_LOW, IncomingTransfer, OutgoingTransfer } from './transfer.js';
import { RelayLane, T_CTL, ctlText, deriveKey, makeKeyPair } from './relay.js';

const CTL_ID = 0;
const DATA_ID = 1;
const CTL_FRAGMENT = 16_000;
const CTL_HIGH = 1 << 20;
const CONNECT_TIMEOUT = 25_000;
/** How long a direct connection may take before the relay is asked for. */
const FALLBACK_AFTER = 4_000;
const PATH_EVERY = 2_000;
const SAMPLE_EVERY = 250;
/** Most WebRTC connections to one device, whatever the settings say. */
export const MAX_LINKS = 8;
const AUTO_LINKS = 4;
export const MAX_RELAY_LANES = 4;

/** A WebRTC data channel as a lane. */
class RtcLane {
  constructor(lid, pc, dc) {
    this.lid = lid;
    this.kind = 'rtc';
    this.pc = pc;
    this.dc = dc;
    this.open = false;
    this.opened = deferred();
    this.pendingCands = [];
    this.sentTotal = 0;
  }

  get ready() {
    return this.open && this.dc.readyState === 'open';
  }

  get buffered() {
    return this.dc.bufferedAmount;
  }

  send(buf) {
    this.dc.send(buf);
    this.sentTotal += buf.byteLength;
  }
}

export class PeerSession extends Emitter {
  constructor({ localId, remoteId, signaling, getIce, hasRelay, settings, limiter }) {
    super();
    this.localId = localId;
    this.remoteId = remoteId;
    this.signaling = signaling;
    this.getIce = getIce;
    this.hasRelay = hasRelay ?? (() => false);
    this.settings = settings;
    this.limiter = limiter;
    // The polite side yields when both offer at once.
    this.polite = localId < remoteId;
    this.links = new Map();
    this.ctl = null;
    this.state = 'idle';
    this.path = null;
    this.pathInfo = null;
    this.iceErrors = [];
    this.saturatedRtc = false;
    this.saturatedRelay = false;
    this.linkSeq = 0;
    this.linkPending = 0;
    this.relay = null;
    this.relayKeys = new Map();
    this.relayRequested = false;
    this.relayPending = 0;
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
    // Every signal carries this session's id (sid) and the other side's session it is for
    // (rsid), so messages from an earlier connection still in flight cannot disturb this one.
    this.sid = randomToken(9);
    this.remoteSid = null;
  }

  /** A signal that starts a conversation (an offer, a relay request), rather than replying. */
  static opens(data) {
    return (data.k === 'sdp' && data.d?.type === 'offer') || data.k === 'relay-please';
  }

  /**
   * What a signal from the other device means for this session: 'take' it, 'drop' it (it
   * belongs to an earlier connection), or 'replace' this session (the other device
   * reconnected and is starting over). Relay keys name their relay session themselves.
   */
  judge(data) {
    if (data.rsid && data.rsid !== this.sid) return 'drop';
    if (data.k === 'relay-key') return 'take';
    if (this.remoteSid && data.sid !== this.remoteSid) return PeerSession.opens(data) ? 'replace' : 'drop';
    return 'take';
  }

  // ---- connecting --------------------------------------------------------------------

  /** Connects if not already; resolves once control messages can flow, by either path. */
  connect() {
    if (this.state === 'idle') {
      if (this.settings.forceRelay && this.hasRelay()) this.#requestRelay();
      else this.#main();
    }
    return this.connected.promise;
  }

  #beginConnecting() {
    if (this.state !== 'idle') return;
    this.state = 'connecting';
    this.emit('state');
    this.connectTimer = setTimeout(() => {
      if (this.state === 'connecting') this.close(this.#noRouteMessage());
    }, CONNECT_TIMEOUT);
  }

  #connectedNow() {
    if (this.state !== 'connecting' && this.state !== 'idle') return;
    clearTimeout(this.connectTimer);
    clearTimeout(this.fallbackTimer);
    this.state = 'connected';
    this.connected.resolve();
    this.sampleTimer = setInterval(() => this.#sampleLanes(), SAMPLE_EVERY);
    this.emit('state');
  }

  #noRouteMessage() {
    if (this.hasRelay()) return 'Could not connect to this device, directly or through the relay';
    const turn = (this.rtcConfig?.iceServers ?? []).some((s) => [].concat(s.urls).some((u) => u.startsWith('turn')));
    return turn
      ? 'Could not connect to this device'
      : 'Could not connect: the networks block a direct connection and no relay is configured';
  }

  #main() {
    if (!this.mainPromise) {
      this.#beginConnecting();
      this.mainPromise = this.#createMain();
      this.mainPromise.catch((e) => this.#rtcFailed(e.message));
    }
    return this.mainPromise;
  }

  async #createMain() {
    this.rtcConfig = {
      ...(await this.getIce()),
      bundlePolicy: 'max-bundle',
      iceTransportPolicy: this.settings.turnOnly ? 'relay' : 'all',
    };
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
    pc.onicecandidateerror = (e) => {
      if (this.iceErrors.length < 20) this.iceErrors.push({ url: e.url, code: e.errorCode, text: e.errorText });
    };
    pc.onconnectionstatechange = () => this.#onMainState();
    if (this.hasRelay()) {
      this.fallbackTimer = setTimeout(() => {
        if (!this.ctlReady()) this.#requestRelay();
      }, FALLBACK_AFTER);
    }
    return pc;
  }

  #signal(data) {
    this.signaling.signal(this.remoteId, { ...data, sid: this.sid, rsid: this.remoteSid });
  }

  /** Negotiation from the signaling server, handled strictly in arrival order. */
  handleSignal(data) {
    if (data.k !== 'relay-key' && this.remoteSid === null && data.sid) this.remoteSid = data.sid;
    this.sigChain = this.sigChain.then(() => this.#handleSignal(data)).catch((e) => console.warn('signal', e));
  }

  async #handleSignal(data) {
    if (this.state === 'closed') return;
    if (data.k === 'relay-key') {
      this.#onRelayKey(data);
      return;
    }
    if (data.k === 'relay-please') {
      if (!this.relay) {
        this.relayRequested = false;
        this.#requestRelay();
      }
      return;
    }
    // Always relay: WebRTC is not started, whatever the other device offers.
    if (this.settings.forceRelay && !this.mainPromise) return;
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
      if (!this.pathTimer) this.pathTimer = setInterval(() => this.#detectPath(), PATH_EVERY);
    } else if (s === 'failed') {
      // A network change: try new candidates over the same DTLS/SCTP association, which
      // lets transfers in progress carry on.
      if (this.ctl && this.restarts < 2) {
        this.restarts++;
        this.main.restartIce();
      } else {
        this.#rtcFailed(this.ctl ? 'Connection lost' : null);
      }
    } else if (s === 'closed') {
      this.#rtcFailed('Connection closed');
    }
  }

  /** WebRTC is gone or never came: carry on through the relay if there is one. */
  #rtcFailed(reason) {
    if (this.state === 'closed') return;
    if (this.hasRelay()) {
      if (!this.relayRequested) this.#requestRelay();
      if (this.#relayCtlOpen() || this.state === 'connecting') return;
      // Mid-transfer: the relay gets a moment to take over before the session gives up.
      clearTimeout(this.rescueTimer);
      this.rescueTimer = setTimeout(() => {
        if (!this.ctlReady()) this.close(reason ?? this.#noRouteMessage());
      }, 15_000);
      return;
    }
    this.close(reason ?? this.#noRouteMessage());
  }

  /** Which way WebRTC goes, refreshed every couple of seconds: Chrome may switch paths. */
  async #detectPath() {
    if (!this.main || this.state === 'closed') return;
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
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const types = [local?.candidateType, remote?.candidateType];
      const path = types.includes('relay') ? 'turn' : types.every((t) => t === 'host') ? 'lan' : 'direct';
      const summarize = (kind) => {
        const out = {};
        stats.forEach((c) => {
          if (c.type !== kind) return;
          const proto = c.relayProtocol ?? c.protocol;
          const k = proto ? `${c.candidateType}/${proto}` : c.candidateType;
          out[k] = (out[k] ?? 0) + 1;
        });
        return out;
      };
      this.pathInfo = {
        path,
        local: { type: local?.candidateType, protocol: local?.protocol, relayProtocol: local?.relayProtocol, url: local?.url },
        remote: { type: remote?.candidateType, protocol: remote?.protocol },
        rtt: pair.currentRoundTripTime,
        bytesSent: pair.bytesSent,
        bytesReceived: pair.bytesReceived,
        localCandidates: summarize('local-candidate'),
        remoteCandidates: summarize('remote-candidate'),
      };
      if (path !== this.path) {
        this.path = path;
        this.emit('path', path);
        this.emit('state');
      }
    } catch {
      /* closed meanwhile */
    }
  }

  // ---- the relay ---------------------------------------------------------------------

  /**
   * Gets a relay session going. Only the polite side asks the server, so two requests never
   * cross; the other side asks it to (through signaling, which works without any connection).
   */
  #requestRelay() {
    if (!this.hasRelay() || this.relayRequested || this.state === 'closed') return;
    this.relayRequested = true;
    this.#beginConnecting();
    if (this.polite) this.signaling.send({ t: 'relay', to: this.remoteId, sid: this.sid, rsid: this.remoteSid });
    else this.#signal({ k: 'relay-please' });
  }

  /**
   * A ticket from the server, for a session with this device. Both devices get it, and if
   * both asked at once there are two: each side keeps the one with the smaller id, so both
   * end up in the same session.
   */
  onRelayTicket(ticket) {
    if (this.state === 'closed') return;
    if (ticket.role === 'b' && this.remoteSid === null && ticket.sid) this.remoteSid = ticket.sid;
    if (this.relay && this.relay.ticket.session <= ticket.session) return;
    if (this.relay) this.#dropRelay();
    this.relayRequested = true;
    this.#beginConnecting();
    const relay = { ticket, key: deferred(), keyPair: makeKeyPair(), lanes: new Map(), keyStarted: false };
    this.relay = relay;
    relay.keyPair.then(
      ({ pub }) => this.#signal({ k: 'relay-key', session: ticket.session, pub }),
      (e) => relay.key.reject(e),
    );
    const early = this.relayKeys.get(ticket.session);
    if (early) this.#onRelayKey({ session: ticket.session, pub: early });
    this.#openRelayLane(0);
  }

  #onRelayKey({ session, pub }) {
    if (typeof session !== 'string' || typeof pub !== 'string') return;
    const relay = this.relay;
    if (!relay || relay.ticket.session !== session) {
      // The other device's key can beat our ticket here; keep it for when the ticket comes.
      this.relayKeys.set(session, pub);
      if (this.relayKeys.size > 4) this.relayKeys.delete(this.relayKeys.keys().next().value);
      return;
    }
    if (relay.keyStarted) return;
    relay.keyStarted = true;
    relay.keyPair
      .then(({ pair }) => deriveKey(pair, pub, session))
      .then(
        (k) => relay.key.resolve(k),
        (e) => relay.key.reject(e),
      );
  }

  #openRelayLane(index) {
    const relay = this.relay;
    if (!relay) return null;
    if (relay.lanes.has(index)) return relay.lanes.get(index);
    const lane = new RelayLane(relay.ticket, index, relay.key.promise, {
      onReady: (l) => {
        l.opened.resolve(l);
        if (index === 0) this.#connectedNow();
        this.#lanesChanged();
      },
      onFrame: (l, plain) => {
        if (new Uint8Array(plain, 0, 1)[0] === T_CTL) this.#onCtlText(ctlText(plain));
        else this.#onData(l, plain);
      },
      onClose: (l, why) => {
        l.opened.reject(new Error(why));
        if (relay.lanes.get(index) === l) relay.lanes.delete(index);
        this.#lanesChanged();
        if (index === 0 && this.relay === relay && !this.#rtcCtlOpen() && this.state !== 'closed') {
          this.close(why.includes('other device') ? 'The other device left' : `Relay lost: ${why}`);
        }
      },
      onDrain: () => this.wakeDrain(),
    });
    lane.opened = deferred();
    relay.lanes.set(index, lane);
    return lane;
  }

  #dropRelay() {
    const relay = this.relay;
    this.relay = null;
    if (!relay) return;
    for (const l of relay.lanes.values()) l.close('replaced');
  }

  relayLaneCount() {
    return this.relay ? this.relay.lanes.size : 0;
  }

  /** One more relay lane: the first asks the server for a session, later ones tell the other device. */
  async addRelayLane() {
    if (!this.hasRelay()) throw new Error('no relay');
    this.relayPending++;
    this.emit('state');
    try {
      if (!this.relay) {
        this.#requestRelay();
        const t0 = performance.now();
        while (!this.relay?.lanes.get(0)) {
          if (performance.now() - t0 > 10_000 || this.state === 'closed') throw new Error('no relay ticket');
          await new Promise((r) => setTimeout(r, 50));
        }
        return await withTimeout(this.relay.lanes.get(0).opened.promise, 15_000, 'the relay did not connect');
      }
      let index = 0;
      while (this.relay.lanes.has(index)) index++;
      if (index >= MAX_RELAY_LANES) throw new Error('enough relay lanes');
      const lane = this.#openRelayLane(index);
      await this.sendCtl({ t: 'relay-lane', n: index });
      try {
        return await withTimeout(lane.opened.promise, 15_000, 'the relay lane did not connect');
      } catch (e) {
        lane.close(e.message);
        throw e;
      }
    } finally {
      this.relayPending--;
      this.emit('state');
    }
  }

  /** Closes one relay lane that did not help, unless control messages depend on it. */
  closeRelayLane(lane) {
    if (lane.index === 0 && this.#ctlVia() === 'relay') return;
    lane.close('not needed');
  }

  // ---- control channel ---------------------------------------------------------------

  #setupCtl(ctl) {
    ctl.bufferedAmountLowThreshold = CTL_HIGH / 4;
    ctl.onopen = () => {
      this.ctl = ctl;
      this.#connectedNow();
      this.emit('state');
    };
    ctl.onmessage = (e) => this.#onCtlText(e.data);
    ctl.onclose = () => {
      if (!this.#relayCtlOpen()) this.#rtcFailed('Connection closed');
    };
  }

  #rtcCtlOpen() {
    return this.ctl?.readyState === 'open';
  }

  #relayCtlOpen() {
    return Boolean(this.relay?.lanes.get(0)?.ready);
  }

  ctlReady() {
    return this.#rtcCtlOpen() || this.#relayCtlOpen();
  }

  /** WebRTC while it is direct; the relay when WebRTC is absent or goes through TURN. */
  #ctlVia() {
    const rtc = this.#rtcCtlOpen();
    const relay = this.#relayCtlOpen();
    if (rtc && (!relay || this.path === 'lan' || this.path === 'direct')) return 'rtc';
    if (relay) return 'relay';
    return null;
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
    const via = this.#ctlVia();
    if (via === 'relay') {
      const lane = this.relay.lanes.get(0);
      while (lane.buffered > CTL_HIGH * 8 && lane.ready) await this.waitDrain(50);
      lane.sendCtl(s);
      return;
    }
    if (via !== 'rtc') throw new Error('not connected');
    const ctl = this.ctl;
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
      case 'relay-lane':
        if (Number.isInteger(m.n) && m.n > 0 && m.n < MAX_RELAY_LANES) this.#openRelayLane(m.n);
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
    const link = new RtcLane(lid, pc, dc);
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LANE_LOW;
    dc.onopen = () => {
      link.open = true;
      link.opened.resolve(link);
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

  /** Every lane that can take data now, WebRTC and relay. */
  openLanes() {
    const out = [];
    for (const l of this.links.values()) if (l.ready) out.push(l);
    if (this.relay) for (const l of this.relay.lanes.values()) if (l.ready) out.push(l);
    return out;
  }

  #allLanes() {
    return [...this.links.values(), ...(this.relay ? this.relay.lanes.values() : [])];
  }

  laneOpen(lid) {
    return this.openLanes().some((l) => l.lid === lid);
  }

  linkCount() {
    return this.links.size;
  }

  /** How many WebRTC connections the settings allow to this device. */
  targetLinks() {
    const s = this.settings.maxLinks;
    return s === 'auto' ? AUTO_LINKS : Math.max(1, Math.min(MAX_LINKS, Number(s) || 1));
  }

  /**
   * Each lane's drain rate, from what it has sent minus what it still holds, measured only
   * while it holds something (an idle lane says nothing about its speed). Its queue limit
   * follows: about 0.75 s of its own rate, so a slow lane never sits on much.
   */
  #sampleLanes() {
    const now = performance.now();
    for (const l of this.#allLanes()) {
      const buffered = l.buffered;
      const drained = l.sentTotal - buffered;
      const s = l.sample;
      if (s && (s.buffered > 0 || buffered > 0)) {
        const inst = ((drained - s.drained) / (now - s.at)) * 1000;
        l.rate = l.rate ? l.rate * 0.7 + inst * 0.3 : inst;
      }
      l.sample = { at: now, drained, buffered };
      l.high = l.rate ? Math.min(LANE_HIGH, Math.max(1 << 20, l.rate * 0.75)) : 2 << 20;
    }
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

  /**
   * What to add when a transfer wants more: on a LAN, WebRTC connections first (they stay
   * local); elsewhere relay lanes first (in measurements one relay lane outran any number of
   * WebRTC connections). A kind that once failed to raise the rate is not tried again.
   */
  nextGrowth() {
    const rtcOk =
      this.#rtcCtlOpen() &&
      this.path &&
      this.path !== 'turn' &&
      !this.saturatedRtc &&
      this.links.size < this.targetLinks();
    const relayOk =
      this.hasRelay() && this.settings.boost !== false && !this.saturatedRelay && this.relayLaneCount() < MAX_RELAY_LANES;
    if (this.path === 'lan') return rtcOk ? 'rtc' : relayOk ? 'relay' : null;
    return relayOk ? 'relay' : rtcOk ? 'rtc' : null;
  }

  get growing() {
    return this.linkPending > 0 || this.relayPending > 0;
  }

  /** Opens one more WebRTC connection to this device, negotiated over `ctl`. */
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
      if (link || this.links.size >= MAX_LINKS || !this.rtcConfig) return;
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

  /** The payload size of one chunk: as large as both ends accept, at most 256 KB. */
  chunkSize() {
    const rtcMax = this.main?.sctp?.maxMessageSize;
    const message = rtcMax ? Math.min(rtcMax, 256 * 1024) : this.relay ? 256 * 1024 : 65_536;
    // 4 KB multiples keep disk writes aligned.
    return Math.max(4096, Math.floor((message - HDR) / 4096) * 4096);
  }

  /** How data travels now, for people: lan, direct, turn, relay, direct+relay, turn+relay. */
  route() {
    const lanes = this.openLanes();
    const rtc = lanes.some((l) => l.kind === 'rtc');
    const relay = lanes.some((l) => l.kind === 'relay');
    if (rtc && relay) return this.path === 'turn' ? 'turn+relay' : 'direct+relay';
    if (relay) return 'relay';
    if (rtc) return this.path ?? 'direct';
    return null;
  }

  /** Everything worth knowing about this connection, for the diagnostics panel. */
  diagnostics() {
    return {
      state: this.state,
      route: this.route(),
      control: this.#ctlVia(),
      webrtc: this.main
        ? {
            connection: this.main.connectionState,
            ice: this.main.iceConnectionState,
            path: this.pathInfo,
            maxMessageSize: this.main.sctp?.maxMessageSize ?? null,
            iceErrors: this.iceErrors,
          }
        : null,
      relay: this.relay ? { session: `${this.relay.ticket.session.slice(0, 6)}…`, lanes: this.relay.lanes.size } : null,
      lanes: this.#allLanes().map((l) => ({
        lane: l.lid,
        kind: l.kind,
        ready: l.ready,
        queued: l.buffered,
        rate: Math.round(l.rate ?? 0),
      })),
      chunk: this.chunkSize(),
      saturated: { webrtc: this.saturatedRtc, relay: this.saturatedRelay },
      closeReason: this.closeReason ?? null,
    };
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
    clearTimeout(this.fallbackTimer);
    clearTimeout(this.rescueTimer);
    clearInterval(this.pathTimer);
    clearInterval(this.sampleTimer);
    for (const t of [...this.outgoing.values(), ...this.incoming.values()]) t.onSessionClosed(reason);
    for (const l of this.links.values()) {
      try {
        l.pc.close();
      } catch {
        /* already closed */
      }
    }
    this.links.clear();
    this.#dropRelay();
    this.wakeDrain();
    this.connected.reject(new Error(reason));
    this.emit('state');
    this.emit('closed', reason);
  }
}
