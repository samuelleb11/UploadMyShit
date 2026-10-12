// Writes received chunks to disk, off the page's main thread, and reports each file the
// moment it is complete so the user has it while the rest is still arriving.
//
// Three modes:
//   dir   a folder the user picked (File System Access, Chrome): every file streams into
//         its final place inside its folders and appears there, finished, when its last
//         byte lands. Nothing is held in memory past the write queue.
//   opfs  the browser's private storage, for browsers without folder access: each file,
//         once complete, is handed to the page to save as a download.
//   mem   memory, the last resort, otherwise like opfs.
//
// Chunks arrive in any order; each lands at its own offset. Chunks queued for one file
// while a write is in flight are sorted and merged, so a busy disk gets fewer, larger
// writes without any tuning.

const HDR = 16;
const POST_EVERY = 1 << 20;
const MAX_RUN = 16 << 20;
const OPFS_DIR = 'ums-incoming';

let job = null;

const post = (m) => self.postMessage(m);

self.onmessage = (e) => {
  const m = e.data;
  switch (m.op) {
    case 'probe':
      probe().then((opfs) => post({ op: 'probe', opfs }));
      break;
    case 'init':
      init(m).catch(fail);
      break;
    case 'w':
      write(m.fi, m.ci, m.buf);
      break;
    case 'finish':
      finish().catch(fail);
      break;
    case 'abort':
      abort().finally(() => post({ op: 'aborted' }));
      break;
  }
};

function fail(err) {
  if (!job || job.failed) return;
  job.failed = true;
  post({ op: 'error', message: `${err?.name ?? 'Error'}: ${err?.message ?? err}` });
}

async function probe() {
  try {
    if (!navigator.storage?.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    const fh = await dir.getFileHandle('.probe', { create: true });
    if (!fh.createSyncAccessHandle) return false;
    const h = await fh.createSyncAccessHandle();
    h.close();
    await dir.removeEntry('.probe');
    return true;
  } catch {
    return false;
  }
}

async function exists(dir, name) {
  for (const get of ['getFileHandle', 'getDirectoryHandle']) {
    try {
      await dir[get](name);
      return true;
    } catch (e) {
      if (e.name === 'TypeMismatchError') return true;
      // A name Chrome refuses cannot be taken either; creating it falls back (see named()).
      if (e.name === 'TypeError') return false;
      if (e.name !== 'NotFoundError') throw e;
    }
  }
  return false;
}

/** A name stripped to letters, digits and plain punctuation, with no dot or space at its ends. */
function plainName(name) {
  const s = name
    .replace(/[^\p{L}\p{N} _().,'&+=@#$%!-]/gu, '_')
    .replace(/^[.\s]+/u, (m) => '_'.repeat(m.length))
    .replace(/[.\s]+$/u, '');
  return s || 'file';
}

/**
 * dir[get](name, { create: true }), and if Chrome refuses the name ("Name is not allowed":
 * its rules are not all documented), a plain version of it, then a numbered one. One odd
 * name must not end a transfer of many files. Resolves to [handle, the name used].
 */
async function named(dir, get, name, fallback) {
  for (const candidate of [name, plainName(name), fallback]) {
    try {
      return [await dir[get](candidate, { create: true }), candidate];
    } catch (e) {
      if (e.name !== 'TypeError' || candidate === fallback) throw e;
    }
  }
}

/** `name`, or `name (2)`, `name (3)`... whichever is free in `dir`. */
async function freeName(dir, name, isDir) {
  if (!(await exists(dir, name))) return name;
  const dot = isDir ? -1 : name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
  throw new Error(`no free name for ${name}`);
}

/**
 * Nothing already in the chosen folder is overwritten: a top-level file or folder whose
 * name is taken gets the next free "name (n)", and everything under it moves with it.
 */
async function claimTopLevel(root, files, dirs) {
  const tops = new Map();
  const dirTops = new Set();
  const dirSet = new Set(dirs);
  for (const p of [...files.map((f) => f.path), ...dirs]) {
    const slash = p.indexOf('/');
    const top = slash < 0 ? p : p.slice(0, slash);
    if (slash >= 0 || dirSet.has(p)) dirTops.add(top);
    tops.set(top, top);
  }
  for (const top of tops.keys()) tops.set(top, await freeName(root, top, dirTops.has(top)));
  const remap = (p) => {
    const slash = p.indexOf('/');
    return slash < 0 ? tops.get(p) : tops.get(p.slice(0, slash)) + p.slice(slash);
  };
  for (const f of files) f.path = remap(f.path);
  return dirs.map(remap);
}

async function init(m) {
  job = {
    mode: m.mode,
    chunk: m.chunk,
    tid: m.tid,
    written: 0,
    posted: 0,
    flushTimer: 0,
    failed: false,
    aborted: false,
    dirCache: new Map(),
    files: m.files.map((f) => ({
      path: f.p,
      size: f.s,
      type: f.y || '',
      written: 0,
      queue: [],
      busy: false,
      handle: null,
      opening: null,
      fileHandle: null,
      done: false,
      completed: null,
      dir: null,
      parts: m.mode === 'mem' ? [] : null,
    })),
    dirs: m.dirs,
  };
  if (job.mode === 'dir') {
    job.root = m.dir;
    job.dirs = await claimTopLevel(job.root, job.files, job.dirs);
  } else if (job.mode === 'opfs') {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    job.root = await base.getDirectoryHandle(job.tid, { create: true });
  }
  // Empty files and empty folders are complete before a byte arrives: make them now, so
  // they appear in order with the rest rather than at the very end.
  if (job.mode === 'dir') for (const d of job.dirs) await dirFor(`${d}/x`);
  for (const [fi, f] of job.files.entries()) {
    if (f.size === 0) await complete(f, fi);
  }
  post({ op: 'ready', paths: job.files.map((f) => f.path), dirs: job.dirs });
}

/** The folder a path's file goes in, created as needed; lookups are shared. */
function dirFor(path) {
  const segments = path.split('/').slice(0, -1);
  let key = '';
  let promise = Promise.resolve(job.root);
  for (const seg of segments) {
    key = key ? `${key}/${seg}` : seg;
    let cached = job.dirCache.get(key);
    if (!cached) {
      const fallback = `folder-${job.dirCache.size + 1}`;
      cached = promise.then(async (parent) => (await named(parent, 'getDirectoryHandle', seg, fallback))[0]);
      job.dirCache.set(key, cached);
    }
    promise = cached;
  }
  return promise;
}

async function open(f, fi) {
  if (job.mode === 'opfs') {
    f.fileHandle = await job.root.getFileHandle(`f${fi}`, { create: true });
    return f.fileHandle.createSyncAccessHandle();
  }
  f.dir = await dirFor(f.path);
  const base = f.path.split('/').pop();
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(base)?.[0] ?? '';
  const [handle, used] = await named(f.dir, 'getFileHandle', base, `file-${fi + 1}${ext}`);
  f.fileHandle = handle;
  if (used !== base) f.path = f.path.slice(0, f.path.length - base.length) + used;
  return f.fileHandle.createWritable({ keepExistingData: false });
}

function write(fi, ci, buf) {
  if (!job || job.failed || job.aborted) return;
  const f = job.files[fi];
  if (!f || f.done) return;
  const view = new Uint8Array(buf, HDR);
  if (job.mode === 'mem') {
    f.parts[ci] = view;
    account(f, view.length);
    if (f.written === f.size) complete(f, fi);
    return;
  }
  f.queue.push({ ci, view });
  if (!f.busy) drain(f, fi);
}

/** Groups sorted chunks into runs of consecutive indexes. */
function runs(batch) {
  const out = [];
  let run = null;
  for (const item of batch) {
    if (run && item.ci === run.next && run.bytes < MAX_RUN) {
      run.views.push(item.view);
      run.bytes += item.view.length;
      run.next++;
    } else {
      run = { ci: item.ci, next: item.ci + 1, views: [item.view], bytes: item.view.length };
      out.push(run);
    }
  }
  return out;
}

function concat(views, bytes) {
  const out = new Uint8Array(bytes);
  let o = 0;
  for (const v of views) {
    out.set(v, o);
    o += v.length;
  }
  return out;
}

async function drain(f, fi) {
  f.busy = true;
  try {
    if (!f.handle) f.handle = await (f.opening ??= open(f, fi));
    while (f.queue.length && !job.aborted) {
      const batch = f.queue;
      f.queue = [];
      batch.sort((a, b) => a.ci - b.ci);
      for (const run of runs(batch)) {
        const position = run.ci * job.chunk;
        if (job.mode === 'opfs') {
          let at = position;
          for (const v of run.views) {
            f.handle.write(v, { at });
            at += v.length;
          }
        } else {
          const data = run.views.length === 1 ? run.views[0] : concat(run.views, run.bytes);
          await f.handle.write({ type: 'write', position, data });
        }
        account(f, run.bytes);
      }
    }
    if (f.written === f.size && !f.done) await complete(f, fi);
  } catch (err) {
    fail(err);
  } finally {
    f.busy = false;
  }
  if (f.queue.length && !f.done && !job.failed) drain(f, fi);
}

function account(f, n) {
  f.written += n;
  job.written += n;
  if (job.written - job.posted >= POST_EVERY) flushWritten();
  else if (!job.flushTimer) job.flushTimer = setTimeout(flushWritten, 50);
}

function flushWritten() {
  clearTimeout(job.flushTimer);
  job.flushTimer = 0;
  job.posted = job.written;
  post({ op: 'written', n: job.written });
}

/** Closes a finished file and tells the page, which can use it right away. */
function complete(f, fi) {
  f.done = true;
  f.completed = closeAndReport(f, fi).catch(fail);
  return f.completed;
}

async function closeAndReport(f, fi) {
  let blob = null;
  if (job.mode === 'dir') {
    // Chrome writes to a swap file; this moves it into place under its real name.
    const h = f.handle ?? (await open(f, fi));
    await h.close();
  } else if (job.mode === 'opfs') {
    const h = f.handle ?? (await open(f, fi));
    h.flush();
    h.close();
    blob = await f.fileHandle.getFile();
  } else {
    blob = new Blob(f.parts, { type: f.type });
    f.parts = null;
  }
  f.handle = null;
  flushWritten();
  post({ op: 'file', fi, path: f.path, blob });
}

async function finish() {
  // Every byte was received before the page asks; wait for the last writes to land and
  // the last files to close.
  while (job.files.some((f) => !f.done) && !job.failed) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await Promise.all(job.files.map((f) => f.completed));
  if (job.failed) return;
  flushWritten();
  post({ op: 'finished', paths: job.files.map((f) => f.path), dirs: job.dirs });
}

async function abort() {
  if (!job) return;
  job.aborted = true;
  for (const f of job.files) {
    const h = f.handle ?? (f.opening && !f.done ? await f.opening.catch(() => null) : null);
    if (!h || f.done) continue;
    try {
      if (job.mode === 'opfs') h.close();
      else {
        // Abandons the swap file, then removes the empty placeholder Chrome created under
        // the real name: nothing half-written is left in the folder.
        await h.abort();
        await f.dir?.removeEntry(f.fileHandle?.name ?? f.path.split('/').pop());
      }
    } catch {
      /* already closed */
    }
  }
  if (job.mode === 'opfs') {
    try {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle(OPFS_DIR);
      await base.removeEntry(job.tid, { recursive: true });
    } catch {
      /* nothing to remove */
    }
  }
}
