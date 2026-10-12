// The relay's end-to-end encryption, under Node's WebCrypto: node --test 'tests/web/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKeyPair, deriveKey, Sealer, Opener, ctlFrame, ctlText, T_CTL } from '../../web/js/relay.js';

async function pair(session = 'session-0123456789') {
  const a = await makeKeyPair();
  const b = await makeKeyPair();
  return {
    ka: await deriveKey(a.pair, b.pub, session),
    kb: await deriveKey(b.pair, a.pub, session),
  };
}

test('both sides derive the same key, and frames open on the other side', async () => {
  const { ka, kb } = await pair();
  const seal = new Sealer(ka, 0, 2);
  const open = new Opener(kb, 0, 2);
  for (const n of [0, 1, 16, 262144]) {
    const plain = new Uint8Array(n).map((_, i) => i % 251);
    const frame = await seal.seal(plain);
    assert.equal(frame.byteLength, 12 + n + 16);
    assert.deepEqual(new Uint8Array(await open.open(frame)), plain);
  }
});

test('a different session gives a different key', async () => {
  const a = await makeKeyPair();
  const b = await makeKeyPair();
  const k1 = await deriveKey(a.pair, b.pub, 'session-aaaaaaaaaaaa');
  const k2 = await deriveKey(b.pair, a.pub, 'session-bbbbbbbbbbbb');
  const frame = await new Sealer(k1, 0, 0).seal(new Uint8Array([1, 2, 3]));
  await assert.rejects(new Opener(k2, 0, 0).open(frame));
});

test('tampered, replayed and misdirected frames are refused', async () => {
  const { ka, kb } = await pair();
  const seal = new Sealer(ka, 1, 0);
  const f1 = await seal.seal(new Uint8Array([9, 9, 9]));
  const f2 = await seal.seal(new Uint8Array([8, 8, 8]));
  const tampered = new Uint8Array(f1.slice(0));
  tampered[14] ^= 1;
  await assert.rejects(new Opener(kb, 1, 0).open(tampered.buffer));
  const open = new Opener(kb, 1, 0);
  await open.open(f1);
  await open.open(f2);
  await assert.rejects(open.open(f1), /replayed/);
  await assert.rejects(new Opener(kb, 0, 0).open(f1), /another lane/);
  await assert.rejects(new Opener(kb, 1, 3).open(f1), /another lane/);
});

test('control messages round-trip as frames', () => {
  const text = JSON.stringify({ t: 'ack', tn: 1, note: 'é ü 文件' });
  const frame = ctlFrame(text);
  assert.equal(new Uint8Array(frame)[0], T_CTL);
  assert.equal(ctlText(frame), text);
});
