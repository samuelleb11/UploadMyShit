// Two browsers, one server, real WebRTC: files and folders go from one page to the other and
// arrive byte for byte.
//
//   cargo build && (cd tests/e2e && npm ci && node transfer.mjs)
//
// UMS_BIN       the server binary (default: target/debug/uploadmyshit)
// CHROME_PATH   a Chrome to drive; unset uses Playwright's own Chromium (the CI image's)
// UMS_E2E_MB    size of the large file, in MB (default 256)
//
// With worker/node_modules installed (cd worker && npm ci), the relay Worker runs locally
// under `wrangler dev` and the relay scenarios run too.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

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
        await new Promise((resolve) => {
          const check = () => t.terminal && resolve();
          t.on('state', check);
          check();
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
