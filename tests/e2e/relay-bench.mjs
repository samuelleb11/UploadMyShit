// Throughput through the relay Worker, measured with two real browsers.
//
//   RELAY_URL=wss://<your worker>.workers.dev node relay-bench.mjs
//   RELAY_URL=ws://127.0.0.1:8787 node relay-bench.mjs      (against `npm run dev` in worker/)
//
// For each setup, the sending page streams for SECONDS over LANES WebSockets, keeping at most
// WINDOW bytes unacknowledged (as the app's credit window does, so the relay never buffers
// without bound); the receiving page acknowledges every 100 ms.
//
// CHROME_PATH   a Chrome to drive; unset uses Playwright's own Chromium
// RELAY_SECRET  when the Worker requires tickets, the secret to sign them with

import { createHmac, randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

const RELAY = (process.env.RELAY_URL ?? 'ws://127.0.0.1:8787').replace(/\/$/, '');
const SECONDS = Number(process.env.SECONDS ?? 10);
const SETUPS = [
  { lanes: 1, msg: 64 * 1024 },
  { lanes: 1, msg: 256 * 1024 },
  { lanes: 3, msg: 256 * 1024 },
];

function ticket(session) {
  if (!process.env.RELAY_SECRET) return '';
  const exp = Math.floor(Date.now() / 1000) + 600;
  const sig = createHmac('sha256', process.env.RELAY_SECRET).update(`${session}.${exp}`).digest('base64url');
  return `?exp=${exp}&sig=${sig}`;
}

const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
const [ba, bb] = await Promise.all([launch(), launch()]);
const [A, B] = await Promise.all([ba.newPage(), bb.newPage()]);

async function run({ lanes, msg }) {
  const session = randomBytes(16).toString('base64url');
  const urls = (role) => Array.from({ length: lanes }, (_, i) => `${RELAY}/v1/${session}/${role}/${i}${ticket(session)}`);
  const open = (page, list) =>
    page.evaluate(async (list) => {
      window.socks = list.map((u) => {
        const ws = new WebSocket(u);
        ws.binaryType = 'arraybuffer';
        ws.paired = new Promise((resolve, reject) => {
          ws.onmessage = (e) => typeof e.data === 'string' && e.data.includes('paired') && resolve();
          ws.onclose = (e) => reject(new Error(`closed ${e.code} ${e.reason}`));
          setTimeout(() => reject(new Error('not paired within 15 s')), 15000);
        });
        return ws;
      });
    }, list);
  const t0 = Date.now();
  await open(B, urls('b'));
  await open(A, urls('a'));
  await Promise.all([A, B].map((p) => p.evaluate(() => Promise.all(window.socks.map((s) => s.paired)))));
  const pairMs = Date.now() - t0;

  // Receiver: count and acknowledge.
  await B.evaluate(() => {
    window.got = window.socks.map(() => 0);
    window.socks.forEach((ws, i) => {
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') window.got[i] += e.data.byteLength;
      };
    });
    window.ackTimer = setInterval(() => {
      window.socks.forEach((ws, i) => ws.send(JSON.stringify({ t: 'ack', n: window.got[i] })));
    }, 100);
  });
  // Sender: stream for SECONDS within the window, per lane.
  await A.evaluate(
    async ({ msg, seconds }) => {
      const WINDOW = 16 << 20;
      const buf = new ArrayBuffer(msg);
      const sent = window.socks.map(() => 0);
      const acked = window.socks.map(() => 0);
      window.socks.forEach((ws, i) => {
        ws.onmessage = (e) => {
          if (typeof e.data === 'string') acked[i] = JSON.parse(e.data).n ?? acked[i];
        };
      });
      const end = performance.now() + seconds * 1000;
      while (performance.now() < end) {
        let progressed = false;
        window.socks.forEach((ws, i) => {
          while (ws.bufferedAmount < 4 << 20 && sent[i] - acked[i] < WINDOW) {
            ws.send(buf.slice(0));
            sent[i] += msg;
            progressed = true;
          }
        });
        await new Promise((r) => setTimeout(r, progressed ? 0 : 2));
      }
    },
    { msg, seconds: SECONDS },
  );
  const got = await B.evaluate(() => {
    clearInterval(window.ackTimer);
    window.socks.forEach((ws) => ws.close());
    return window.got;
  });
  await A.evaluate(() => window.socks.forEach((ws) => ws.close()));
  const mbps = got.map((g) => ((g * 8) / 1e6 / SECONDS).toFixed(1));
  const total = ((got.reduce((a, b) => a + b, 0) * 8) / 1e6 / SECONDS).toFixed(1);
  console.log(
    `${lanes} lane(s), ${msg / 1024} KB messages: ${total.padStart(6)} Mbps` +
      `${lanes > 1 ? ` (${mbps.join(' / ')})` : ''}, paired in ${pairMs} ms`,
  );
}

const rounds = Number(process.env.ROUNDS ?? 1);
for (let r = 0; r < rounds; r++) {
  for (const s of SETUPS) {
    try {
      await run(s);
    } catch (e) {
      console.log(`${s.lanes} lane(s), ${s.msg / 1024} KB messages: failed: ${e.message}`);
    }
  }
}
await ba.close();
await bb.close();
