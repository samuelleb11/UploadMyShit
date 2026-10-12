// Two browsers, one server, real WebRTC: files and folders go from one page to the other and
// arrive byte for byte.
//
//   cargo build && (cd tests/e2e && npm ci && node transfer.mjs)
//
// UMS_BIN       the server binary (default: target/debug/uploadmyshit)
// CHROME_PATH   a Chrome to drive; unset uses Playwright's own Chromium (the CI image's)
// UMS_E2E_MB    size of the large file, in MB (default 256)
// UMS_E2E_THROTTLE  slow both pages' CPUs by this factor, to shake out races CI's slower
//                   runners would find
//
// With worker/node_modules installed (cd worker && npm ci), the relay Worker runs locally
// under `wrangler dev` and the relay scenarios run too.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { safePath } from '../../web/js/files.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const BIN = process.env.UMS_BIN ?? join(repo, 'target', 'debug', 'uploadmyshit');
const BIG_MB = Number(process.env.UMS_E2E_MB ?? 256);

async function freePort() {
  const srv = createServer().listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  srv.close();
  return port;
}

const RELAY_SECRET = 'e2e-relay-secret';

/** The relay Worker under `wrangler dev`, or null when wrangler is not installed. */
async function startRelay() {
  const wrangler = join(repo, 'worker', 'node_modules', '.bin', 'wrangler');
  if (!existsSync(wrangler)) return null;
  const port = await freePort();
  const proc = spawn(wrangler, ['dev', '--ip', '127.0.0.1', '--port', String(port), '--var', `RELAY_SECRET:${RELAY_SECRET}`], {
    cwd: join(repo, 'worker'),
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    detached: true,
  });
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { proc, url: `ws://127.0.0.1:${port}` };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  process.kill(-proc.pid);
  throw new Error('wrangler dev did not start');
}

async function startServer(relay) {
  const port = await freePort();
  const relayArgs = relay ? ['--relay-url', relay.url, '--relay-secret', RELAY_SECRET] : [];
  const proc = spawn(BIN, ['--bind', `127.0.0.1:${port}`, '--stun-urls=', ...relayArgs], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, UMS_LOG: 'warn' },
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/readyz`)).ok) return { proc, url };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('server did not start');
}

// ---- page-side helpers, run inside the browser -------------------------------------

/**
 * A digest of a file of any size: SHA-256 over the SHA-256s of its 16 MB pieces. Whole-file
 * digests would need the file in memory, which Chrome refuses past a few hundred MB.
 */
function installHash() {
  window.__hash = async (blob) => {
    const PIECE = 16 << 20;
    const parts = [];
    for (let o = 0; o === 0 || o < blob.size; o += PIECE) {
      parts.push(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.slice(o, o + PIECE).arrayBuffer())));
    }
    const all = new Uint8Array(parts.length * 32);
    parts.forEach((p, i) => all.set(p, i * 32));
    const d = await crypto.subtle.digest('SHA-256', all);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
}

/**
 * Builds the files to send in the sending page and returns their digests by path. The large
 * file is written to the page's private storage first, so what is sent is disk-backed like
 * a file the user drops.
 */
async function makeFiles(bigMb) {
  const hash = window.__hash;
  const random = (size) => {
    const parts = [];
    for (let o = 0; o < size; o += 65536) {
      const b = new Uint8Array(Math.min(65536, size - o));
      crypto.getRandomValues(b);
      parts.push(b);
    }
    return new Blob(parts);
  };
  const root = await navigator.storage.getDirectory();
  const bigHandle = await root.getFileHandle('e2e-big.bin', { create: true });
  const w = await bigHandle.createWritable();
  const bigSize = bigMb * 1e6 + 12345;
  for (let o = 0; o < bigSize; o += 32e6) await w.write(random(Math.min(32e6, bigSize - o)));
  await w.close();
  const big = await bigHandle.getFile();
  const specs = [
    ['photos/2024/a.jpg', 3_000_001],
    ['photos/2024/b.jpg', 1],
    ['photos/2024/deep/c.raw', 9_999_999],
    ['photos/empty.txt', 0],
    ['notes/é ü 文件.txt', 4321],
  ];
  for (let i = 0; i < 200; i++) specs.push([`many/small-${i}.txt`, 100 + i * 37]);
  const files = [{ path: 'big.bin', file: big }];
  const hashes = { 'big.bin': await hash(big) };
  for (const [path, size] of specs) {
    const blob = random(size);
    files.push({ path, file: new File([blob], path.split('/').pop(), { lastModified: Date.now() }) });
    hashes[path] = await hash(blob);
  }
  window.__e2eFiles = files;
  return hashes;
}

/** Removes a destination folder once checked: CI's browser storage quota is small. */
async function dropTree(dirName) {
  await (await navigator.storage.getDirectory()).removeEntry(dirName, { recursive: true });
}

async function readTree(dirName) {
  const hash = window.__hash;
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(dirName);
  const out = { files: {}, dirs: [] };
  const walk = async (dir, prefix) => {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'file') out.files[path] = await hash(await handle.getFile());
      else {
        out.dirs.push(path);
        await walk(handle, path);
      }
    }
  };
  await walk(root, '');
  return out;
}

// ---- the test ----------------------------------------------------------------------

const relay = await startRelay();
if (!relay) console.log('(relay scenarios skipped: run `npm ci` in worker/ to include them)');
const { proc, url } = await startServer(relay);
// Two browser processes, as two machines would have: one process would put both ends on
// a single network thread and halve what WebRTC can do.
// Real (temporary) profiles: an incognito context's storage quota is too small for the
// large file.
const profiles = [mkdtempSync(join(tmpdir(), 'ums-e2e-a-')), mkdtempSync(join(tmpdir(), 'ums-e2e-b-'))];
const launch = (dir) =>
  chromium.launchPersistentContext(dir, {
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    acceptDownloads: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-first-run'],
  });
const browsers = await Promise.all(profiles.map(launch));
const failures = [];
let pageB = null;
const step = async (name, fn) => {
  const t0 = performance.now();
  try {
    await fn();
    console.log(`ok   ${name} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${e.stack ?? e}`);
    const receiverErrors = await pageB
      ?.evaluate(() => window.__ums.transfers().filter((t) => t.direction === 'in' && t.error).map((t) => t.error))
      .catch(() => []);
    if (receiverErrors?.length) console.log(`     receiver said: ${[...new Set(receiverErrors)].join(' | ')}`);
  }
};

try {
  const a = browsers[0].pages()[0] ?? (await browsers[0].newPage());
  const b = browsers[1].pages()[0] ?? (await browsers[1].newPage());
  pageB = b;
  for (const [name, page] of [['A', a], ['B', b]]) {
    page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name} ${m.type()}] ${m.text()}`);
    });
  }
  const throttle = Number(process.env.UMS_E2E_THROTTLE ?? 1);
  if (throttle > 1) {
    for (const [ctx, page] of [[browsers[0], a], [browsers[1], b]]) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    }
  }
  await a.goto(url);
  await b.goto(url);
  await a.evaluate(installHash);
  await b.evaluate(installHash);

  let idA;
  let idB;
  await step('both pages see each other in their network room', async () => {
    await a.waitForFunction(() => window.__ums?.peers().length === 1, null, { timeout: 10_000 });
    await b.waitForFunction(() => window.__ums?.peers().length === 1, null, { timeout: 10_000 });
    idA = await a.evaluate(() => window.__ums.me.id);
    idB = await b.evaluate(() => window.__ums.me.id);
    assert.equal(await a.evaluate(() => window.__ums.peers()[0].id), idB);
  });

  const hashes = await a.evaluate(makeFiles, BIG_MB);
  const total = await a.evaluate(() => window.__e2eFiles.reduce((s, f) => s + f.file.size, 0));

  /** Sends the prepared files A -> B; resolves with the sender's view of it. */
  const send = (dirs = ['empty-folder', 'photos/2024/nothing-here']) =>
    a.evaluate(
      async ({ to, dirs }) => {
        const t = window.__ums.send(to, window.__e2eFiles, dirs);
        let maxLanes = 0;
        const lanesTimer = setInterval(() => (maxLanes = Math.max(maxLanes, t.session.openLanes().length)), 200);
        const started = performance.now();
        // A stalled transfer would wait forever; two minutes is far beyond any test's size.
        await new Promise((resolve) => {
          const check = () => t.terminal && resolve();
          t.on('state', check);
          check();
          setTimeout(() => {
            if (!t.terminal) t.fail(new Error('the transfer stalled (test timeout)'));
          }, 120_000);
        });
        clearInterval(lanesTimer);
        return {
          state: t.state,
          error: t.error,
          seconds: (performance.now() - (t.startedAt ?? started)) / 1000,
          maxLanes,
          path: t.session.path,
          chunk: t.chunk,
          waits: Object.fromEntries(Object.entries(t.waitTotals).map(([k, v]) => [k, Math.round(v)])),
          lanesUsed: [...t.sentByLane.keys()],
        };
      },
      { to: idB, dirs },
    );

  await step('a folder tree streams into the chosen folder, byte for byte', async () => {
    await b.evaluate(async () => {
      const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-1', { create: true });
      // A file already there must not be overwritten: the incoming "big.bin" becomes "big (2).bin".
      const keep = await (await dest.getFileHandle('big.bin', { create: true })).createWritable();
      await keep.write('keep me');
      await keep.close();
      window.__fileEvents = [];
      window.__ums.setAutoAccept((t) => {
        t.on('file', (f) => window.__fileEvents.push({ path: f.path, at: performance.now() }));
        t.on('state', () => t.state === 'done' && (window.__doneAt = performance.now()));
        return { mode: 'dir', dir: dest };
      });
    });
    const r = await send();
    assert.equal(r.state, 'done', r.error);
    console.log(
      `     ${(total / 1e6).toFixed(0)} MB in ${r.seconds.toFixed(2)}s = ${(total / 1e6 / r.seconds).toFixed(0)} MB/s` +
        ` over ${r.maxLanes} connection(s), path ${r.path}, chunk ${r.chunk} B, waits(ms) ${JSON.stringify(r.waits)}`,
    );
    const tree = await b.evaluate(readTree, 'dest-1');
    const expected = { ...hashes, 'big (2).bin': hashes['big.bin'] };
    delete expected['big.bin'];
    for (const [path, hash] of Object.entries(expected)) assert.equal(tree.files[path], hash, `content of ${path}`);
    assert.equal(Object.keys(tree.files).length, Object.keys(expected).length + 1, 'no extra files');
    assert.ok(tree.dirs.includes('empty-folder') && tree.dirs.includes('photos/2024/nothing-here'), 'empty folders');
    // Files are usable as they complete, not all at the end.
    const ev = await b.evaluate(() => ({ events: window.__fileEvents, doneAt: window.__doneAt }));
    assert.equal(ev.events.length, Object.keys(hashes).length);
    const firstSmall = ev.events.find((e) => e.path.startsWith('many/'));
    assert.ok(ev.doneAt - ev.events[0].at > 0, 'the first file completed before the transfer did');
    assert.ok(firstSmall, 'small files reported');
    await b.evaluate(dropTree, 'dest-1');
  });

  await step('automatic mode arrives intact and reports the connections it chose', async () => {
    await b.evaluate(async () => {
      const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-auto', { create: true });
      window.__ums.setAutoAccept(() => ({ mode: 'dir', dir: dest }));
    });
    const r = await send([]);
    assert.equal(r.state, 'done', r.error);
    const tree = await b.evaluate(readTree, 'dest-auto');
    for (const [path, hash] of Object.entries(hashes)) assert.equal(tree.files[path], hash, `content of ${path}`);
    const saturated = await a.evaluate((id) => window.__ums.sessions.get(id)?.saturated, idB);
    console.log(
      `     ${(total / 1e6 / r.seconds).toFixed(0)} MB/s, settled on ${r.maxLanes} connection(s)` +
        `${saturated ? ' (more stopped helping)' : ''}, waits(ms) ${JSON.stringify(r.waits)}`,
    );
    await b.evaluate(dropTree, 'dest-auto');
  });

  await step('extra connections open when asked and the data stays intact', async () => {
    await a.evaluate(() => (window.__ums.settings.maxLinks = '4'));
    await b.evaluate(async () => {
      const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-2', { create: true });
      window.__ums.setAutoAccept(() => ({ mode: 'dir', dir: dest }));
    });
    const r = await send([]);
    assert.equal(r.state, 'done', r.error);
    console.log(
      `     ${(total / 1e6).toFixed(0)} MB in ${r.seconds.toFixed(2)}s = ${(total / 1e6 / r.seconds).toFixed(0)} MB/s over ${r.maxLanes} connection(s), waits(ms) ${JSON.stringify(r.waits)}`,
    );
    assert.ok(r.maxLanes >= 2, `expected more than one connection, saw ${r.maxLanes}`);
    const tree = await b.evaluate(readTree, 'dest-2');
    for (const [path, hash] of Object.entries(hashes)) assert.equal(tree.files[path], hash, `content of ${path}`);
    await b.evaluate(dropTree, 'dest-2');
    await a.evaluate(() => (window.__ums.settings.maxLinks = 'auto'));
  });

  await step('without folder access each file is handed over as it completes', async () => {
    await b.evaluate(() => {
      window.__ums.setAutoAccept((t) => {
        window.__lastIncoming = t;
        return { mode: 'opfs' };
      });
    });
    const r = await send([]);
    assert.equal(r.state, 'done', r.error);
    console.log(`     ${(total / 1e6 / r.seconds).toFixed(0)} MB/s into private storage, waits(ms) ${JSON.stringify(r.waits)}`);
    const got = await b.evaluate(async () => {
      const out = {};
      for (const f of window.__lastIncoming.completed) out[f.path] = await window.__hash(f.blob);
      return out;
    });
    for (const [path, hash] of Object.entries(hashes)) assert.equal(got[path], hash, `content of ${path}`);
    await b.evaluate(() => window.__lastIncoming.release());
  });

  await step('the receiver can stop a transfer and nothing half-written is left', async () => {
    await b.evaluate(async () => {
      const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-3', { create: true });
      window.__ums.setAutoAccept((t) => {
        t.on('change', () => {
          if (t.state === 'receiving' && t.written > 20e6) t.cancel();
        });
        return { mode: 'dir', dir: dest };
      });
    });
    const r = await send([]);
    assert.equal(r.state, 'cancelled');
    await new Promise((res) => setTimeout(res, 500));
    const tree = await b.evaluate(readTree, 'dest-3');
    assert.ok(!('big.bin' in tree.files), 'the interrupted file did not appear');
  });

  /** Closes both pages' connections to each other, so the next transfer connects afresh. */
  const reconnect = async () => {
    // Known settings first: a step that failed may have left its own behind.
    for (const page of [a, b]) {
      await page.evaluate(() => Object.assign(window.__ums.settings, { forceRelay: false, turnOnly: false, maxLinks: 'auto' }));
    }
    await a.evaluate((id) => window.__ums.sessions.get(id)?.close('test'), idB);
    await b.evaluate((id) => window.__ums.sessions.get(id)?.close('test'), idA);
  };
  const routeOf = () => a.evaluate((id) => window.__ums.sessions.get(id)?.route(), idB);

  /** An OS-level drag of a path on disk, dropped at x, y: what a person dragging from a file manager does. */
  const dragFromDisk = async (ctx, page, path, x, y) => {
    const cdp = await ctx.newCDPSession(page);
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', { type, x, y, data: { items: [], files: [path], dragOperationsMask: 1 } });
    }
    await cdp.detach();
  };

  /**
   * Chrome's own verdict on names in a real folder on disk: the paths whose file or folder
   * names it refuses ("Name is not allowed"). That check comes before any permission check,
   * so the read access a dropped folder carries is enough to ask it.
   */
  const chromeRefuses = async (ctx, page, paths) => {
    const probe = realpathSync(mkdtempSync(join(tmpdir(), 'ums-probe-')));
    try {
      await page.evaluate(() => {
        const take = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
        window.addEventListener('dragenter', take, true);
        window.addEventListener('dragover', take, true);
        window.__probe = new Promise((res) => window.addEventListener('drop', async (e) => {
          take(e);
          window.removeEventListener('dragenter', take, true);
          window.removeEventListener('dragover', take, true);
          res(await e.dataTransfer.items[0].getAsFileSystemHandle());
        }, { once: true, capture: true }));
      });
      await dragFromDisk(ctx, page, probe, 300, 300);
      return await page.evaluate(async (paths) => {
        const dir = await window.__probe;
        const out = [];
        for (const path of paths) {
          const parts = path.split('/');
          for (const [i, name] of parts.entries()) {
            try {
              await (i < parts.length - 1 ? dir.getDirectoryHandle(name) : dir.getFileHandle(name));
            } catch (e) {
              if (e.name !== 'NotFoundError') out.push(`${path} (${name}): ${e.name} ${e.message}`);
            }
          }
        }
        return out;
      }, paths);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  };

  await step('names a folder refuses arrive cleaned, and the transfer completes', async () => {
    await reconnect();
    await b.evaluate(async () => {
      const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-names', { create: true });
      window.__ums.setAutoAccept(() => ({ mode: 'dir', dir: dest }));
    });
    // As an older sender would send them, uncleaned: what the receiver writes instead of each
    // name Chrome refuses in a real folder, and the names it leaves alone.
    const names = {
      "Alice Cooper - School's Out/Visit us.url": "Alice Cooper - School's Out/Visit us.url_",
      "Alice Cooper - School's Out/shortcut.lnk": "Alice Cooper - School's Out/shortcut.lnk_",
      "Alice Cooper - School's Out/desktop.ini": "Alice Cooper - School's Out/_desktop.ini",
      "Alice Cooper - School's Out/soft\u00adhyphen.txt": "Alice Cooper - School's Out/soft_hyphen.txt",
      "Alice Cooper - School's Out/a:b.txt": "Alice Cooper - School's Out/a_b.txt",
      "Alice Cooper - School's Out/trail. ": "Alice Cooper - School's Out/trail",
      "Alice Cooper - School's Out/._guitar.ogg": "Alice Cooper - School's Out/._guitar.ogg",
      "Alice Cooper - School's Out/song.ini~": "Alice Cooper - School's Out/song.ini_",
      "Alice Cooper - School's Out/~notes.txt": "Alice Cooper - School's Out/_notes.txt",
      "Alice Cooper - School's Out/..double": "Alice Cooper - School's Out/._double",
      "Alice Cooper - School's Out/a~b.txt": "Alice Cooper - School's Out/a~b.txt",
      "Alice Cooper - School's Out/.hidden": "Alice Cooper - School's Out/.hidden",
      "Alice Cooper - School's Out/notes.mid": "Alice Cooper - School's Out/notes.mid",
    };
    const r = await a.evaluate(async ({ to, names }) => {
      const files = Object.keys(names).map((path, i) => ({ path, file: new File([`file ${i}`], path.split('/').pop()) }));
      const t = window.__ums.send(to, files, []);
      await new Promise((resolve) => t.on('state', () => t.terminal && resolve()));
      return { state: t.state, error: t.error };
    }, { to: idB, names });
    assert.equal(r.state, 'done', r.error);
    const tree = await b.evaluate(readTree, 'dest-names');
    for (const want of Object.values(names)) assert.ok(want in tree.files, `${want} arrived (got ${Object.keys(tree.files).join(', ')})`);
    assert.deepEqual(await chromeRefuses(browsers[1], b, Object.keys(tree.files)), [], 'Chrome refuses none of them in a real folder');
    await b.evaluate(dropTree, 'dest-names');
  });

  await step('every name the cleaner makes is one Chrome writes in a real folder', async () => {
    // Names Chrome was measured refusing or accepting, then hostile pieces put together at
    // random (seeded, so a failure can be replayed).
    const measured = ['~a', 'a~', '~', 'a~b', '.~a', '..a', '...a', '. a', '.a.', '.a ', 'a.', 'a ', ' a', 'a..b',
      'a\tb', 'a"b', 'a*b', 'a<b', 'a>b', 'a?b', 'a|b', 'a:b', 'soft\u00adhyphen', 'zero\u200bwidth', 'zwj\u200dx',
      'rtl\u202ex', 'bom\ufeffx', 'ls\u2028x', 'x\u00a0', '\u3000x', 'x\u2003', 'e\u0301', '❤️', '👨\u200d👩\u200d👧',
      'x\ufdd0', 'x\uffff', 'x\u{1fffe}', 'con', 'CON.txt', 'con.txt.bak', 'com1', 'com0', 'com¹', 'lpt9', 'clock$',
      'conin$', 'conout$', 'nul.tar.gz', 'desktop.ini', 'Thumbs.db', 'Icon\r', '~$lock.docx', '.~lock.a.odt#', '.lnk',
      'f.LNK', 'f.scf', 'f.url', 'f.{x}', 'f.{x}y}', 'f.{a.b}', 'f.local', 'a.lnk.txt', 'x'.repeat(300)];
    const pieces = ['.', '..', '~', ' ', '\u00a0', '\u3000', '\t', '\r', ':', '"', '*', '?', '<', '>', '|', '\\',
      '\u200b', '\u200d', '\u00ad', '\ufeff', '\u202e', '\ufdd0', '\uffff', '\ud800', '影', 'é', 'e\u0301', '🎸',
      '$', '{', '}', 'a', 'con', 'COM1', 'clock$', '.lnk', '.URL', '.scf', '.{x}', 'desktop.ini', '-', 'x'.repeat(120)];
    let seed = 0xc0ffee;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const raw = [...measured];
    for (let i = 0; i < 2000; i++) raw.push(Array.from({ length: 1 + rand(6) }, () => pieces[rand(pieces.length)]).join(''));
    const cleaned = [...new Set(raw.map(safePath))];
    const enc = new TextEncoder();
    for (const p of cleaned) for (const seg of p.split('/')) assert.ok(enc.encode(seg).length <= 255, `${seg}: too long`);
    assert.deepEqual(await chromeRefuses(browsers[1], b, cleaned), [], 'Chrome refuses none of the cleaned names');
  });

  await step('signals left over from a closed connection do not revive it', async () => {
    // A live connection first, so there are session ids to go stale.
    await reconnect();
    await b.evaluate(async () => {
      const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-stale', { create: true });
      window.__ums.setAutoAccept(() => ({ mode: 'dir', dir: dest }));
    });
    const old = await a.evaluate(async (to) => {
      const t = window.__ums.send(to, [{ path: 'one.txt', file: new File(['1'], 'one.txt') }], []);
      await new Promise((resolve) => t.on('state', () => t.terminal && resolve()));
      const s = window.__ums.sessions.get(to);
      return { sid: s.sid, rsid: s.remoteSid };
    }, idB);
    assert.ok(old.sid && old.rsid);
    await reconnect();
    // What the old connection might still have in flight: an answer, a candidate, and an
    // offer for B's old session.
    await a.evaluate(
      ({ to, old }) => {
        const stale = { sid: old.sid, rsid: old.rsid };
        window.__ums.signal(to, { k: 'sdp', d: { type: 'answer', sdp: 'v=0' }, ...stale });
        window.__ums.signal(to, { k: 'ice', c: { candidate: '', sdpMid: '0' }, ...stale });
        window.__ums.signal(to, { k: 'sdp', d: { type: 'offer', sdp: 'v=0' }, ...stale });
      },
      { to: idB, old },
    );
    await new Promise((r) => setTimeout(r, 500));
    const revived = await b.evaluate((id) => {
      const s = window.__ums.sessions.get(id);
      return s && s.state !== 'closed' ? s.state : null;
    }, idA);
    assert.equal(revived, null, 'B started a connection from stale signals');
    await b.evaluate(dropTree, 'dest-stale');
  });

  if (relay) {
    await step('with no direct path, the page falls back to the relay by itself', async () => {
      await reconnect();
      // TURN only, and no TURN server: WebRTC cannot find any path at all.
      await a.evaluate(() => (window.__ums.settings.turnOnly = true));
      await b.evaluate(() => (window.__ums.settings.turnOnly = true));
      await b.evaluate(async () => {
        const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-fallback', { create: true });
        window.__ums.setAutoAccept(() => ({ mode: 'dir', dir: dest }));
      });
      const r = await send([]);
      assert.equal(r.state, 'done', r.error);
      assert.equal(await routeOf(), 'relay');
      console.log(`     ${(total / 1e6 / r.seconds).toFixed(0)} MB/s through the local relay`);
      const tree = await b.evaluate(readTree, 'dest-fallback');
      for (const [path, hash] of Object.entries(hashes)) assert.equal(tree.files[path], hash, `content of ${path}`);
      await b.evaluate(dropTree, 'dest-fallback');
      await a.evaluate(() => (window.__ums.settings.turnOnly = false));
      await b.evaluate(() => (window.__ums.settings.turnOnly = false));
    });

    // Needs a real TURN server: run with UMS_CLOUDFLARE_TURN_KEY_ID and
    // UMS_CLOUDFLARE_TURN_API_TOKEN in the environment (the test server reads them).
    if (process.env.UMS_CLOUDFLARE_TURN_KEY_ID) {
      await step('a connection that lands on TURN hands its data to the relay', async () => {
        await reconnect();
        await a.evaluate(() => (window.__ums.settings.turnOnly = true));
        await b.evaluate(() => (window.__ums.settings.turnOnly = true));
        await b.evaluate(async () => {
          const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-turn', { create: true });
          window.__ums.setAutoAccept(() => ({ mode: 'dir', dir: dest }));
        });
        const r = await send([]);
        assert.equal(r.state, 'done', r.error);
        const d = await a.evaluate((id) => window.__ums.sessions.get(id).diagnostics(), idB);
        assert.equal(d.webrtc?.path?.path, 'turn', 'WebRTC went through TURN');
        assert.equal(d.route, 'relay');
        assert.equal(d.control, 'relay');
        console.log(`     ${(total / 1e6 / r.seconds).toFixed(0)} MB/s, lanes used: ${r.lanesUsed.join(', ')}`);
        assert.ok(r.lanesUsed.some((lid) => lid.startsWith('r')), 'the relay carried data');
        const tree = await b.evaluate(readTree, 'dest-turn');
        for (const [path, hash] of Object.entries(hashes)) assert.equal(tree.files[path], hash, `content of ${path}`);
        await b.evaluate(dropTree, 'dest-turn');
      });
    }

    await step('a relay lane that swallows data is dropped and what it held is sent again', async () => {
      await reconnect();
      await b.evaluate(async () => {
        const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-hole', { create: true });
        window.__ums.setAutoAccept(() => ({ mode: 'dir', dir: dest }));
      });
      await a.evaluate(async (to) => {
        const t = window.__ums.send(to, [{ path: 'hello.txt', file: new File(['hi'], 'hello.txt') }], []);
        await new Promise((resolve) => t.on('state', () => t.terminal && resolve()));
        await window.__ums.sessions.get(to).addRelayLane();
      }, idB);
      // B's end of the relay lane goes silent without closing: everything sent into it is lost.
      await b.evaluate((id) => {
        const lane = window.__ums.sessions.get(id).relay.lanes.get(0);
        lane.hooks.onFrame = () => {};
      }, idA);
      const r = await send([]);
      assert.equal(r.state, 'done', r.error);
      const d = await a.evaluate((id) => window.__ums.sessions.get(id).diagnostics(), idB);
      assert.ok(!d.lanes.some((l) => l.lane === 'r0'), 'the swallowing lane was dropped');
      console.log(`     done in ${r.seconds.toFixed(1)}s despite the dead lane`);
      const tree = await b.evaluate(readTree, 'dest-hole');
      for (const [path, hash] of Object.entries(hashes)) assert.equal(tree.files[path], hash, `content of ${path}`);
      await b.evaluate(dropTree, 'dest-hole');
    });

    await step('"always use the relay" sends everything through it, encrypted, byte for byte', async () => {
      await reconnect();
      await a.evaluate(() => (window.__ums.settings.forceRelay = true));
      await b.evaluate(async () => {
        const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-relay', { create: true });
        window.__ums.setAutoAccept(() => ({ mode: 'dir', dir: dest }));
      });
      const r = await send([]);
      assert.equal(r.state, 'done', r.error);
      const d = await a.evaluate((id) => window.__ums.sessions.get(id).diagnostics(), idB);
      assert.equal(d.route, 'relay');
      assert.equal(d.webrtc, null, 'no WebRTC connection was made');
      assert.ok(d.lanes.every((l) => l.kind === 'relay'));
      const tree = await b.evaluate(readTree, 'dest-relay');
      for (const [path, hash] of Object.entries(hashes)) assert.equal(tree.files[path], hash, `content of ${path}`);
      await b.evaluate(dropTree, 'dest-relay');
      await a.evaluate(() => (window.__ums.settings.forceRelay = false));
    });

    await step('relay lanes beside a direct connection share the data and keep it intact', async () => {
      await reconnect();
      await b.evaluate(async () => {
        const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-mixed', { create: true });
        window.__ums.setAutoAccept(() => ({ mode: 'dir', dir: dest }));
      });
      // Connect directly first, with a small transfer, then add a relay lane beside it.
      await a.evaluate(async (to) => {
        const t = window.__ums.send(to, [{ path: 'hello.txt', file: new File(['hi'], 'hello.txt') }], []);
        await new Promise((resolve) => t.on('state', () => t.terminal && resolve()));
        await window.__ums.sessions.get(to).addRelayLane();
      }, idB);
      assert.equal(await routeOf(), 'direct+relay');
      const r = await send([]);
      assert.equal(r.state, 'done', r.error);
      const d = await a.evaluate((id) => window.__ums.sessions.get(id).diagnostics(), idB);
      console.log(`     ${(total / 1e6 / r.seconds).toFixed(0)} MB/s over ${d.lanes.map((l) => `${l.lane}/${l.kind}`).join(', ')}`);
      const kinds = new Set(r.lanesUsed.map((lid) => (lid.startsWith('r') ? 'relay' : 'rtc')));
      assert.ok(kinds.has('relay') && kinds.has('rtc'), `data went over both kinds of lane: ${[...kinds]}`);
      const tree = await b.evaluate(readTree, 'dest-mixed');
      for (const [path, hash] of Object.entries(hashes)) assert.equal(tree.files[path], hash, `content of ${path}`);
      await b.evaluate(dropTree, 'dest-mixed');
    });
  }

  await step('a private room is created from the header and joined by pasting its link', async () => {
    await a.locator('#room-action').click();
    await a.waitForURL(/\/r\/[a-z2-9]{10}$/);
    await a.waitForSelector('#room-dialog[open]');
    const link = await a.inputValue('#room-link');
    assert.equal(link, a.url(), 'the dialog shows the room link');
    assert.equal(await a.textContent('#room-action-label'), 'Invite');
    await a.locator('#room-dialog').getByRole('button', { name: 'Close' }).click();
    // A is alone in the room now, and the page says how to bring someone in.
    await a.waitForFunction(() => window.__ums.peers().length === 0);
    await a.getByRole('button', { name: 'Copy link' }).waitFor();

    await b.locator('#room-btn').click();
    await b.fill('#room-code', link);
    await b.press('#room-code', 'Enter');
    await b.waitForURL(link);
    await a.waitForFunction(() => window.__ums.peers().length === 1, null, { timeout: 10_000 });
    await b.waitForFunction(() => window.__ums.peers().length === 1, null, { timeout: 10_000 });
    assert.match(await b.textContent('#room-label'), /^Room [a-z2-9]{10}$/);
  });

  await step('a real folder dropped from disk: clutter left out, bytes intact, every name one Chrome writes in a real folder', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ums-real-')));
    const src = join(root, 'src', 'Album');
    // Kept as they are, or cleaned (Chrome refuses the original in a real folder).
    const keep = {
      '01 - Intro.ogg': '01 - Intro.ogg',
      '02 - Song.ogg': '02 - Song.ogg',
      'notes.chart': 'notes.chart',
      'song.ini': 'song.ini',
      '.gitignore': '.gitignore',
      '~notes.txt': '_notes.txt',
      'song.ini~': 'song.ini_',
      '..double.txt': '._double.txt',
      '.~tilde': '._tilde',
      'a~b.txt': 'a~b.txt',
      'family 👨\u200d👩\u200d👧.jpg': 'family 👨_👩_👧.jpg',
      'Folder~/inner.txt': 'Folder_/inner.txt',
      'emoji 🎸.ogg': 'emoji 🎸.ogg',
      'Sub Folder/inner.ogg': 'Sub Folder/inner.ogg',
      'Visit us.url': 'Visit us.url_',
      'shortcut.lnk': 'shortcut.lnk_',
      'a:b.txt': 'a_b.txt',
      'trail. ': 'trail',
      'con.txt': '_con.txt',
      'zero\u200bwidth.txt': 'zero_width.txt',
      [`${'影'.repeat(80)}.ogg`]: `${'影'.repeat(78)}.ogg`,
    };
    // What Windows, macOS and Linux leave in folders; none of it may be sent.
    const junk = ['Thumbs.db', 'desktop.ini', '.DS_Store', '._01 - Intro.ogg', 'Icon\r', '~$lock.docx', '.directory',
      '__MACOSX/x.jpg', '$RECYCLE.BIN/y.jpg', '.Trash-1000/z.jpg', '.Spotlight-V100/store.db'];
    const sums = {};
    Object.keys(keep).forEach((name, i) => {
      const bytes = randomBytes(name.endsWith('.ogg') ? 2e6 + i * 77777 : 1000 + i);
      mkdirSync(dirname(join(src, name)), { recursive: true });
      writeFileSync(join(src, name), bytes);
      sums[keep[name]] = createHash('sha256').update(bytes).digest('hex');
    });
    for (const name of junk) {
      mkdirSync(dirname(join(src, name)), { recursive: true });
      writeFileSync(join(src, name), 'junk');
    }
    try {
      await reconnect();
      await b.evaluate(async () => {
        const dest = await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-real', { create: true });
        window.__real = null;
        window.__ums.setAutoAccept((t) => {
          window.__real = t;
          return { mode: 'dir', dir: dest };
        });
      });
      // Dropped from disk onto B in A's page: the app's own drop handling collects it.
      const peer = a.locator(`.peer[data-id="${idB}"]`);
      await peer.waitFor({ timeout: 15_000 });
      const box = await peer.boundingBox();
      await dragFromDisk(browsers[0], a, src, box.x + box.width / 2, box.y + box.height / 2);
      await b.waitForFunction(() => window.__real?.terminal, null, { timeout: 120_000 });
      const got = await b.evaluate(() => ({ state: window.__real.state, error: window.__real.error, count: window.__real.count }));
      assert.equal(got.state, 'done', got.error);
      assert.equal(got.count, Object.keys(keep).length, 'the sender left the clutter out');
      // Exactly the expected files, byte for byte.
      const arrived = await b.evaluate(async () => {
        const out = {};
        const walk = async (dir, pre) => {
          for await (const [n, h] of dir.entries()) {
            if (h.kind === 'directory') await walk(h, `${pre}${n}/`);
            else {
              const d = await crypto.subtle.digest('SHA-256', await (await h.getFile()).arrayBuffer());
              out[`${pre}${n}`] = [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
            }
          }
        };
        await walk(await (await (await navigator.storage.getDirectory()).getDirectoryHandle('dest-real')).getDirectoryHandle('Album'), '');
        return out;
      });
      assert.deepEqual(Object.keys(arrived).sort(), Object.keys(sums).sort(), 'the expected names');
      for (const [name, sum] of Object.entries(sums)) assert.equal(arrived[name], sum, `content of ${name}`);
      // Chrome's own verdict, from a real folder on disk, on every name that arrived.
      const refused = await chromeRefuses(browsers[1], b, Object.keys(arrived).map((p) => `Album/${p}`));
      assert.deepEqual(refused, [], 'Chrome refuses none of the names that arrived');
      await b.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('dest-real', { recursive: true }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await step('a tab left open across a deploy reloads itself, once', async () => {
    // A third tab whose server, by its welcome, now has newer page files than it runs.
    const c = await browsers[0].newPage();
    await c.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((msg) => {
        const m = JSON.parse(msg);
        if (m.t === 'welcome') m.assets = 'ffffffffffff';
        ws.send(JSON.stringify(m));
      });
    });
    let loads = 0;
    c.on('load', () => loads++);
    await c.goto(url);
    await c.waitForFunction(() => sessionStorage.getItem('ums.reloadedFor') === 'ffffffffffff', null, { timeout: 10_000 });
    await c.waitForLoadState('load');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(loads, 2, `loaded ${loads} times: once, then one reload`);
    await c.close();
    // The server notices the extra tab is gone a moment later (slower on CI): wait for it,
    // so the next step counts only the two test devices.
    for (let i = 0; i < 100; i++) {
      if ((await (await fetch(`${url}/healthz`)).json()).stats.peers === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  await step('the server stayed healthy and saw both devices', async () => {
    const health = await (await fetch(`${url}/healthz`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.stats.peers, 2);
  });
} finally {
  await Promise.all(browsers.map((b) => b.close()));
  proc.kill();
  if (relay) process.kill(-relay.proc.pid);
  for (const dir of profiles) rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall passed');
