// Where received files go, and the page's side of the writer worker.
//
// In Chrome the user picks a folder once. Its handle is kept in IndexedDB, so later
// transfers stream straight into it: Chrome asks to confirm access at most once per visit,
// and not at all once the user chose "Allow on every visit".

import { randomToken } from './util.js';

export const canPickFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const DB = 'uploadmyshit';
const STORE = 'kv';
const OPFS_DIR = 'ums-incoming';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let savedDir = null;
let opfsUsable = null;

/** Loads the remembered folder and clears what earlier visits left in private storage. */
export async function initStorage() {
  if (canPickFolder) savedDir = (await idbGet('destDir').catch(() => null)) ?? null;
  opfsUsable = probeOpfs();
  cleanupOpfs();
}

export function destinationName() {
  return savedDir?.name ?? null;
}

export async function destinationGranted() {
  if (!savedDir) return false;
  try {
    return (await savedDir.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** Asks for a new folder. Needs a click: call it straight from the click handler. */
export async function chooseDestination() {
  const dir = await window.showDirectoryPicker({ id: 'ums-destination', mode: 'readwrite', startIn: 'downloads' });
  savedDir = dir;
  await idbSet('destDir', dir).catch(() => {});
  return dir;
}

/**
 * The folder to write into: the remembered one if access is (or can be) granted, else a
 * new pick. Call it first thing in a click handler, before any other await, so Chrome
 * still counts the click as the user's.
 */
export async function ensureDestination() {
  if (savedDir) {
    try {
      if ((await savedDir.queryPermission({ mode: 'readwrite' })) === 'granted') return savedDir;
      if ((await savedDir.requestPermission({ mode: 'readwrite' })) === 'granted') return savedDir;
    } catch {
      // The folder was moved or deleted: pick again.
    }
  }
  return chooseDestination();
}

function probeOpfs() {
  return new Promise((resolve) => {
    let w;
    try {
      w = new Worker(new URL('./sink-worker.js', import.meta.url), { type: 'module' });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => {
      w.terminate();
      resolve(false);
    }, 3000);
    w.onmessage = (e) => {
      clearTimeout(timer);
      w.terminate();
      resolve(Boolean(e.data?.opfs));
    };
    w.postMessage({ op: 'probe' });
  });
}

/** Whether downloads stage in private storage (true) or memory (false). */
export function storageMode() {
  return opfsUsable ?? Promise.resolve(false);
}

/**
 * Private storage holds received files until the page closes. A transfer's folder is
 * locked for as long as its page lives, so this removes only what no open page still uses.
 */
async function cleanupOpfs() {
  try {
    if (!navigator.storage?.getDirectory || !navigator.locks) return;
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    const held = new Set((await navigator.locks.query()).held.map((l) => l.name));
    for await (const name of base.keys()) {
      if (!held.has(`ums-job-${name}`)) await base.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch {
    /* private storage unavailable */
  }
}

/** One transfer's writer. */
export class Sink {
  constructor() {
    this.tid = randomToken(9);
    this.worker = new Worker(new URL('./sink-worker.js', import.meta.url), { type: 'module' });
    this.onWritten = () => {};
    this.onFile = () => {};
    this.onError = () => {};
    this.waiters = new Map();
    this.worker.onmessage = (e) => this.#onMessage(e.data);
    this.worker.onerror = (e) => this.onError(new Error(e.message || 'the writer stopped'));
  }

  #onMessage(m) {
    switch (m.op) {
      case 'written':
        this.onWritten(m.n);
        break;
      case 'file':
        this.onFile(m);
        break;
      case 'error':
        this.onError(new Error(m.message));
        this.#settle('ready', null, new Error(m.message));
        this.#settle('finished', null, new Error(m.message));
        break;
      default:
        this.#settle(m.op, m);
    }
  }

  #wait(op) {
    return new Promise((resolve, reject) => this.waiters.set(op, { resolve, reject }));
  }

  #settle(op, value, error) {
    const w = this.waiters.get(op);
    if (!w) return;
    this.waiters.delete(op);
    if (error) w.reject(error);
    else w.resolve(value);
  }

  /** mode: 'dir' (with dir), 'opfs' or 'mem'. Resolves with the final paths. */
  async init({ mode, dir, files, dirs, chunk }) {
    this.mode = mode;
    if (mode === 'opfs' && navigator.locks) {
      // Held until the page closes or the transfer is cleared: see cleanupOpfs.
      navigator.locks.request(`ums-job-${this.tid}`, () => new Promise((r) => (this.releaseLock = r)));
    }
    const ready = this.#wait('ready');
    this.worker.postMessage({ op: 'init', mode, dir, files, dirs, chunk, tid: this.tid });
    return ready;
  }

  /** Hands the chunk's buffer to the worker; it is unusable here afterwards. */
  write(fi, ci, buf) {
    this.worker.postMessage({ op: 'w', fi, ci, buf }, [buf]);
  }

  async finish() {
    const done = this.#wait('finished');
    this.worker.postMessage({ op: 'finish' });
    const result = await done;
    this.worker.terminate();
    return result;
  }

  async abort() {
    const done = this.#wait('aborted');
    this.worker.postMessage({ op: 'abort' });
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
    this.worker.terminate();
    this.releaseLock?.();
  }

  /** Gives back private storage for a finished download-mode transfer. */
  release() {
    this.releaseLock?.();
  }
}

/** Saves one received file through the browser's downloads. */
export function download(blob, path) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = path.split('/').pop() || 'file';
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // The browser has taken its own reference once the download starts.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
