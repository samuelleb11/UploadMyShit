// The WebSocket to the server: who is in the room, and WebRTC negotiation in transit. It
// reconnects on its own; connections already made between browsers do not depend on it.

import { Emitter } from './util.js';

const PING_EVERY = 20_000;
const DEAD_AFTER = 45_000;

export class Signaling extends Emitter {
  /** hello(): the hello message to send on every (re)connection. */
  constructor(hello) {
    super();
    this.hello = hello;
    this.ws = null;
    this.state = 'offline';
    this.backoff = 500;
    this.stopped = false;
    this.retryTimer = 0;
    this.pingTimer = 0;
    this.lastSeen = 0;
    addEventListener('online', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow();
    });
  }

  start() {
    this.stopped = false;
    this.#open();
  }

  /** Closes and reconnects at once, e.g. to change rooms. */
  restart() {
    this.#teardown();
    this.backoff = 500;
    this.#open();
  }

  reconnectNow() {
    if (this.stopped || this.state === 'ready' || this.state === 'connecting') return;
    clearTimeout(this.retryTimer);
    this.backoff = 500;
    this.#open();
  }

  #open() {
    clearTimeout(this.retryTimer);
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.#setState('connecting');
    ws.onopen = () => {
      ws.send(JSON.stringify(this.hello()));
      this.lastSeen = Date.now();
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastSeen > DEAD_AFTER) ws.close();
        else this.send({ t: 'ping' });
      }, PING_EVERY);
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      this.lastSeen = Date.now();
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'pong') return;
      if (m.t === 'welcome') {
        this.backoff = 500;
        this.#setState('ready');
      }
      this.emit(m.t, m);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      this.#setState('offline');
      if (this.stopped) return;
      const delay = this.backoff * (0.75 + Math.random() / 2);
      this.backoff = Math.min(this.backoff * 2, 15_000);
      this.retryTimer = setTimeout(() => this.#open(), delay);
    };
  }

  #teardown() {
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.#setState('offline');
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  signal(to, data) {
    this.send({ t: 'signal', to, data });
  }
}
