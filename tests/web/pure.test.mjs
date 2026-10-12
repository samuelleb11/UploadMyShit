// The page's DOM-free modules, under Node's own test runner: node --test tests/web
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safePath, uniquePaths, commonRoot } from '../../web/js/files.js';
import { formatBytes, formatDuration, randomRoomCode, randomToken, describeDevice } from '../../web/js/util.js';

test('paths from another device are made safe', () => {
  assert.equal(safePath('../../etc/passwd'), 'etc/passwd');
  assert.equal(safePath('/abs/path.txt'), 'abs/path.txt');
  assert.equal(safePath('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(safePath('what?<>:"|*.txt'), 'what_______.txt');
  assert.equal(safePath('trailing. . '), 'trailing');
  assert.equal(safePath('CON.txt'), '_CON.txt');
  assert.equal(safePath('a/./b//c'), 'a/b/c');
  assert.equal(safePath(''), 'file');
  assert.equal(safePath('..'), 'file');
  assert.equal(safePath('evil‮txt.exe'), 'evil_txt.exe');
  const long = safePath(`${'x'.repeat(300)}.jpeg`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.jpeg'));
});

test('duplicate paths get numbered', () => {
  const { files, dirs } = uniquePaths({
    files: [{ path: 'a.txt' }, { path: 'A.txt' }, { path: 'dir/b' }, { path: 'dir/b' }],
    dirs: ['dir/b', 'empty'],
  });
  assert.deepEqual(files.map((f) => f.path), ['a.txt', 'A (2).txt', 'dir/b', 'dir/b (2)']);
  assert.deepEqual(dirs, ['empty']);
});

test('common root', () => {
  assert.equal(commonRoot(['top/a', 'top/b/c']), 'top');
  assert.equal(commonRoot(['top/a', 'other/b']), null);
  assert.equal(commonRoot(['file.txt']), null);
});

test('formatting and tokens', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.54 KB');
  assert.equal(formatBytes(4.2e9), '4.20 GB');
  assert.equal(formatDuration(75), '1m 15s');
  assert.equal(formatDuration(3700), '1h 01m');
  assert.match(randomRoomCode(), /^[a-z2-9]{10}$/);
  assert.match(randomToken(), /^[A-Za-z0-9_-]{32}$/);
});

test('device description', () => {
  const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', maxTouchPoints: 0 };
  assert.deepEqual(describeDevice(mac), { kind: 'desktop', os: 'macOS', browser: 'Chrome' });
  const pixel = { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36' };
  assert.deepEqual(describeDevice(pixel), { kind: 'phone', os: 'Android', browser: 'Chrome' });
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1' };
  assert.deepEqual(describeDevice(iphone), { kind: 'phone', os: 'iOS', browser: 'Chrome' });
});
