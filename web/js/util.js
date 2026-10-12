// Small helpers shared by every module. No DOM here, so Node's test runner can load it.

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '–';
  if (n < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatRate(bytesPerSecond) {
  if (!(bytesPerSecond >= 1)) return '–';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds) {
  // Past 100 hours an estimate says nothing.
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 360_000) return '–';
  if (seconds < 1) return '<1s';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** URL-safe random token, `bytes` of entropy. */
export function randomToken(bytes = 24) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A private room code: 10 characters, about 49 bits, nothing easily misread. */
export function randomRoomCode() {
  const raw = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(raw, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection nobody awaits yet is expected here, not an error.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, message = 'timed out') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class Emitter {
  #handlers = new Map();

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.#handlers.get(type)?.delete(fn);
  }

  emit(type, ...args) {
    for (const fn of this.#handlers.get(type) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`handler for ${type} failed`, err);
      }
    }
  }
}

/**
 * Upload rate cap shared by every transfer, in bytes per second; 0 is unlimited. Callers
 * go into debt and sleep it off, which keeps the long-run rate exact without a timer.
 */
export class TokenBucket {
  constructor(rate = 0) {
    this.setRate(rate);
  }

  setRate(rate) {
    this.rate = Math.max(0, rate || 0);
    this.tokens = 0;
    this.at = performance.now();
  }

  async take(n) {
    if (!this.rate) return;
    const now = performance.now();
    const burst = Math.max(this.rate / 4, 1 << 20);
    this.tokens = Math.min(burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    this.tokens -= n;
    if (this.tokens < 0) await sleep((-this.tokens / this.rate) * 1000);
  }
}

/** A rough description of this device for other people's screens. */
export function describeDevice(nav = globalThis.navigator) {
  const ua = nav?.userAgent ?? '';
  const uad = nav?.userAgentData;
  let os = 'Unknown';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav?.maxTouchPoints > 1)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let kind = 'desktop';
  if (/iPad|Tablet/.test(ua) || (os === 'iOS' && !/iPhone/.test(ua)) || (os === 'Android' && !/Mobile/.test(ua))) {
    kind = 'tablet';
  } else if (uad?.mobile || /iPhone|Mobile/.test(ua)) {
    kind = 'phone';
  }
  return { kind, os, browser };
}

/** A stable hue for an id, so a device keeps its colour across reloads. */
export function hueFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
