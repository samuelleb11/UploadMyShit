// The page's DOM-free modules, under Node's own test runner: node --test tests/web
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safePath, uniquePaths, commonRoot, isJunkFile, isJunkDir, entriesFromInput } from '../../web/js/files.js';
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
  assert.equal(long.length, 240);
  assert.ok(long.endsWith('.jpeg'));
});

test('names follow what Chrome writes in a real folder', () => {
  // Refused by Chrome on a real directory (measured; see the end-to-end test).
  assert.equal(safePath('trail. '), 'trail');
  assert.equal(safePath('  padded name  '), 'padded name');
  assert.equal(safePath('a:b.txt'), 'a_b.txt');
  assert.equal(safePath('soft\u00adhyphen'), 'soft_hyphen');
  assert.equal(safePath('c1\u0085control'), 'c1_control');
  assert.equal(safePath('zero\u200bwidth'), 'zero_width');
  assert.equal(safePath('shortcut.lnk'), 'shortcut.lnk_');
  assert.equal(safePath('page.URL'), 'page.URL_');
  assert.equal(safePath('b.scf'), 'b.scf_');
  assert.equal(safePath('c.{20d04fe0-3aea}'), 'c.{20d04fe0-3aea}_');
  assert.equal(safePath('desktop.ini'), '_desktop.ini');
  assert.equal(safePath('Thumbs.db'), '_Thumbs.db');
  assert.equal(safePath('con'), '_con');
  assert.equal(safePath('CON.txt'), '_CON.txt');
  assert.equal(safePath('com¹.log'), '_com¹.log');
  assert.equal(safePath('CLOCK$'), '_CLOCK$');
  assert.equal(safePath('...'), '_');
  assert.equal(safePath('broken\ud800unicode.txt'), 'broken_unicode.txt');
  assert.equal(safePath('song.ini~'), 'song.ini_');
  assert.equal(safePath('~notes.txt'), '_notes.txt');
  assert.equal(safePath('~~'), '__');
  assert.equal(safePath('a~ '), 'a_');
  assert.equal(safePath('..double'), '._double');
  assert.equal(safePath('.~tilde'), '._tilde');
  assert.equal(safePath('. spaced'), '.spaced');
  assert.equal(safePath('.hidden.'), '.hidden');
  assert.equal(safePath('nbsp\u00a0'), 'nbsp');
  assert.equal(safePath('\u3000wide'), 'wide');
  assert.equal(safePath('family 👨\u200d👩\u200d👧.jpg'), 'family 👨_👩_👧.jpg');
  assert.equal(safePath('x\ufdd0\uffff.txt'), 'x__.txt');
  assert.equal(safePath('f.{x}y}'), 'f.{x}y}_');
  assert.equal(safePath('CONIN$'), '_CONIN$');
  // Accepted by Chrome, so left exactly as they are.
  for (const ok of ['.gitignore', '._guitar.ogg', 'a~b', 'a.~b', 'a~.txt', 'a..b', 'f.{a.b}', 'a.local', 'line\u2028sep', '❤️ love', "School's Out", 'Écran de Zoë 文件.png', 'emoji 🎸.ogg', 'a.lnk.txt', '.DS_Store']) {
    assert.equal(safePath(ok), ok);
  }
  assert.equal(safePath("Alice Cooper - School's Out/notes.mid"), "Alice Cooper - School's Out/notes.mid");
});

test('a name cleaned once is left alone the second time', () => {
  // Hostile pieces, put together at random (seeded, so a failure can be replayed).
  const pieces = ['.', '..', '~', ' ', '\u00a0', '\u3000', '\t', '\r', ':', '"', '*', '?', '<', '>', '|', '\\',
    '\u200b', '\u200d', '\u00ad', '\ufeff', '\u202e', '\ufdd0', '\uffff', '\ud800', '\udc00', '影', 'é', 'e\u0301',
    '🎸', '$', '{', '}', 'a', 'B', 'con', 'COM1', 'lpt9', 'clock$', '.lnk', '.URL', '.scf', '.{x}', 'desktop.ini',
    'thumbs.db', '-', '_', 'x'.repeat(120), '影'.repeat(50)];
  let seed = 0x5eed;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const enc = new TextEncoder();
  // Long names that are also reserved or a shortcut: the "_" added goes past the byte cap.
  const edges = [`con.${'x'.repeat(300)}`, `${'x'.repeat(300)}.lnk`, `con.${'x'.repeat(300)}.url`, `${'x'.repeat(238)}.{y}`];
  for (let i = 0; i < 5000 + edges.length; i++) {
    const raw = edges[i - 5000] ?? Array.from({ length: 1 + rand(8) }, () => pieces[rand(pieces.length)]).join('');
    const once = safePath(raw);
    assert.equal(safePath(once), once, `cleaning ${JSON.stringify(raw)} twice changes it`);
    for (const seg of once.split('/')) assert.ok(enc.encode(seg).length <= 242, `${JSON.stringify(raw)}: ${seg.length}`);
  }
});

test('long names are cut to what every filesystem stores, extension kept', () => {
  const enc = new TextEncoder();
  for (const ch of ['x', 'é', '影', '🎸']) {
    const out = safePath(`${ch.repeat(300)}.ogg`);
    assert.ok(enc.encode(out).length <= 240, `${ch}: ${enc.encode(out).length} bytes`);
    assert.ok(out.endsWith('.ogg'));
    assert.ok(!out.includes('\ufffd'), 'no character cut in half');
  }
});

test('OS clutter is recognised, from every system', () => {
  for (const junk of ['Thumbs.db', 'thumbs.db', 'desktop.ini', 'Desktop.ini', 'ehthumbs.db', '.DS_Store', '._song.ogg', 'Icon\r', '.localized', '.directory', '~$report.docx', '.~lock.notes.odt#', '.nfs000000001234abcd']) {
    assert.ok(isJunkFile(junk), junk);
  }
  for (const dir of ['$RECYCLE.BIN', 'System Volume Information', '.Spotlight-V100', '.Trashes', '.fseventsd', '__MACOSX', '.Trash-1000', 'lost+found']) {
    assert.ok(isJunkDir(dir), dir);
  }
  for (const keep of ['notes.chart', '.gitignore', '.env', 'thumbs.db.bak', 'Icon.png', 'song.ini', '~notes']) {
    assert.ok(!isJunkFile(keep), keep);
  }
  for (const keep of ['Music', '.git', '.config', 'Trash Talk']) assert.ok(!isJunkDir(keep), keep);
});

test('picked files leave clutter out and come back with clean names', () => {
  const pick = (paths) => entriesFromInput(paths.map((p) => ({ name: p.split('/').pop(), webkitRelativePath: p })));
  const out = pick([
    'Album/01 - Intro.ogg',
    'Album/Thumbs.db',
    'Album/._01 - Intro.ogg',
    'Album/__MACOSX/whatever.jpg',
    'Album/Visit us.url',
    'Album/notes:v2.chart',
    'Album/.gitignore',
  ]);
  assert.deepEqual(out.files.map((f) => f.path), ['Album/01 - Intro.ogg', 'Album/Visit us.url_', 'Album/notes_v2.chart', 'Album/.gitignore']);
  assert.deepEqual(out.skipped, ['Album/Thumbs.db', 'Album/._01 - Intro.ogg', 'Album/__MACOSX/whatever.jpg']);
  // Two names that clean to the same one stay two files.
  const twins = pick(['a:b.txt', 'a?b.txt']);
  assert.deepEqual(twins.files.map((f) => f.path), ['a_b.txt', 'a_b (2).txt']);
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
