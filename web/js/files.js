// Turning what the user dropped or picked into a flat list of { path, file }, and turning
// paths another device sent into ones that are safe to write to disk.

// ---- OS clutter -------------------------------------------------------------------

/**
 * What every OS leaves in folders by itself: thumbnail caches, folder settings, Finder and
 * Spotlight data, resource-fork sidecars, trash, lock files of open documents. Nobody means
 * to send them, and some (desktop.ini, Thumbs.db) are names Chrome refuses to write. Names
 * are compared without case, as the systems that make them do.
 */
const JUNK_FILES = new Set([
  // Windows
  'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', 'desktop.ini', 'iconcache.db',
  // macOS
  '.ds_store', '.localized', '.apdisk', '.volumeicon.icns', '.com.apple.timemachine.donotpresent',
  '.lsoverride', 'icon\r',
  // Linux desktops
  '.directory',
]);
const JUNK_FILE_PATTERNS = [
  /^\._/, // macOS AppleDouble sidecars ("._photo.jpg") on non-Mac disks
  /^~\$/, // Microsoft Office lock files ("~$report.docx")
  /^\.~lock\..*#$/, // LibreOffice lock files
  /^\.nfs[0-9a-f]{8,}/i, // NFS files deleted while open
];
/** Folders that hold nothing but the system's own bookkeeping. */
const JUNK_DIRS = new Set([
  // Windows
  '$recycle.bin', 'system volume information', 'recycler', 'recycled',
  // macOS
  '.spotlight-v100', '.trashes', '.fseventsd', '.temporaryitems', '.documentrevisions-v100',
  '.appledouble', '.appledb', '.appledesktop', '__macosx',
  // Linux
  '.trash', 'lost+found',
]);
const JUNK_DIR_PATTERNS = [/^\.trash-\d+$/]; // removable-drive trash, per user id

export function isJunkFile(name) {
  return JUNK_FILES.has(name.toLowerCase()) || JUNK_FILE_PATTERNS.some((p) => p.test(name));
}

export function isJunkDir(name) {
  const n = name.toLowerCase();
  return JUNK_DIRS.has(n) || JUNK_DIR_PATTERNS.some((p) => p.test(n));
}

/** Whether a path (folder/sub/file) is, or lies inside, OS clutter. */
function isJunkPath(path) {
  const parts = path.split('/');
  return isJunkFile(parts.at(-1)) || parts.slice(0, -1).some(isJunkDir);
}

/**
 * The collected entries as they will be sent: clutter left out (and counted, so the sender
 * can be told), every name cleaned to what Chrome will write on the receiving side, then
 * made unique. Cleaning here as well as on receipt means a receiver still running an older
 * page never gets a name its Chrome refuses.
 */
function prepare(files, dirs, skipped) {
  const keptFiles = [];
  for (const f of files) {
    if (isJunkPath(f.path)) skipped.push(f.path);
    else keptFiles.push({ ...f, path: safePath(f.path) });
  }
  const keptDirs = dirs.filter((d) => !d.split('/').some(isJunkDir)).map(safePath);
  return { ...uniquePaths({ files: keptFiles, dirs: keptDirs }), skipped };
}

/**
 * Files and folders from a drop. Must be called synchronously inside the `drop` handler:
 * the browser empties the DataTransfer as soon as the handler yields, so the entries are
 * taken first and only walked afterwards.
 */
export function entriesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items ?? [])].filter((i) => i.kind === 'file');
  const roots = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const plain = [...(dataTransfer.files ?? [])];
  return (async () => {
    if (!roots.length || roots.some((r) => !r)) {
      return prepare(plain.map((file) => ({ path: file.name, file })), [], []);
    }
    const out = { files: [], dirs: [], skipped: [] };
    for (const root of roots) await walk(root, out);
    return prepare(out.files, out.dirs, out.skipped);
  })();
}

/** Files from an `<input type=file>`, with folder structure when it was a folder pick. */
export function entriesFromInput(fileList) {
  return prepare(
    [...fileList].map((file) => ({ path: file.webkitRelativePath || file.name, file })),
    [],
    [],
  );
}

function readAll(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function walk(entry, out) {
  const path = entry.fullPath.replace(/^\/+/, '');
  if (entry.isFile) {
    if (isJunkFile(entry.name)) {
      out.skipped.push(path);
      return;
    }
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.files.push({ path, file });
    return;
  }
  if (!entry.isDirectory) return;
  // Clutter folders are not even opened: a $RECYCLE.BIN can hold thousands of files.
  if (isJunkDir(entry.name)) {
    out.skipped.push(`${path}/`);
    return;
  }
  const children = await readAll(entry.createReader());
  if (!children.length) out.dirs.push(path);
  const files = children.filter((c) => c.isFile);
  const dirs = children.filter((c) => c.isDirectory);
  // Files of one folder are looked up together; folders one after another, which keeps
  // the number of outstanding lookups bounded on a huge tree.
  await Promise.all(files.map((c) => walk(c, out)));
  for (const d of dirs) await walk(d, out);
}

/** A second "a.txt" becomes "a (2).txt", so no entry overwrites another. */
export function uniquePaths({ files, dirs }) {
  const seen = new Set();
  const unique = (p) => {
    let candidate = p;
    for (let i = 2; seen.has(candidate.toLowerCase()); i++) {
      const slash = p.lastIndexOf('/');
      const dot = p.lastIndexOf('.');
      candidate = dot > slash + 1 ? `${p.slice(0, dot)} (${i})${p.slice(dot)}` : `${p} (${i})`;
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  };
  return {
    files: files.map((f) => ({ ...f, path: unique(f.path) })),
    dirs: dirs.filter((d) => !seen.has(d.toLowerCase())).map(unique),
  };
}

// ---- names Chrome will write ----------------------------------------------------------

/**
 * Windows device names, with or without an extension, and the two folder files Windows
 * reserves. Chrome refuses all of them, on every OS. COM0, LPT0 and the superscript ones
 * (COM¹) Chrome lets through, but Windows reserves them too, so a download there would fail.
 */
const RESERVED =
  /^((con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|clock\$|conin\$|conout\$)(\..*)?|desktop\.ini|thumbs\.db)$/i;
/**
 * Extensions Windows runs or follows when a folder is opened, and CLSID extensions (whatever
 * follows the last dot, from "{" to "}"); Chrome refuses them.
 */
const SHELL_EXTENSIONS = /\.(lnk|scf|url|\{[^.]*\})$/i;
/** Bytes per name: ext4 and most Linux filesystems allow 255; room is kept for " (2)" and "_". */
const MAX_NAME_BYTES = 240;

const utf8 = new TextEncoder();

/** `name` cut to at most `max` UTF-8 bytes on a character boundary, extension kept. */
function fitBytes(name, max) {
  if (utf8.encode(name).length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  const room = max - utf8.encode(ext).length;
  let base = '';
  let used = 0;
  for (const ch of name.slice(0, name.length - ext.length)) {
    const n = utf8.encode(ch).length;
    if (used + n > room) break;
    base += ch;
    used += n;
  }
  return base + ext;
}

/**
 * One file or folder name, made one Chrome will create in a real folder. Its File System
 * Access check, as measured against a real directory (see tests/e2e/transfer.mjs):
 *  - nowhere: control or invisible formatting characters (soft hyphen, zero-width joiner,
 *    direction marks), Unicode noncharacters, or any of " * / : < > ? \\ |;
 *  - one leading dot is fine (".gitignore"); past it, the name may not start with a space, a
 *    dot or "~", and it may not end with one either ("..a", ".~a", "~a", "a~", "a." and
 *    "a " are all refused, "a~b" and "a..b" are not);
 *  - no shortcut or CLSID extension, no Windows reserved name.
 * Names Chrome accepts are left exactly as they are; a character it refuses becomes "_", so
 * different names stay different. Spaces and dots at the ends go, as Windows drops them.
 */
function cleanSegment(segment) {
  // One rule can expose another (cutting a long name can leave "~" at its end), so they are
  // applied until none changes anything; a name cleaned once is then left alone the second
  // time, by the receiver.
  let s = segment;
  for (let i = 0, prev = null; s !== prev && i < 4; i++) {
    prev = s;
    s = cleanOnce(s);
  }
  return s;
}

function cleanOnce(segment) {
  let s = segment
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '_')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Noncharacter_Code_Point}"*/:<>?\\|]/gu, '_');
  s = fitBytes(s, MAX_NAME_BYTES).replace(/[.\p{White_Space}]+$/u, '');
  const dot = s.startsWith('.') ? '.' : '';
  s = dot + s.slice(dot.length).replace(/^\p{White_Space}+/u, '').replace(/^[.~]+/u, (m) => '_'.repeat(m.length));
  s = s.replace(/~+$/u, (m) => '_'.repeat(m.length));
  if (!s && segment) s = '_';
  if (RESERVED.test(s)) s = `_${s}`;
  if (SHELL_EXTENSIONS.test(s)) s = `${s}_`;
  return s;
}

/**
 * A path from another device, made safe to create under the folder the user chose: no
 * `..`, no absolute paths, no characters a filesystem refuses, no Windows device names.
 */
export function safePath(raw) {
  const parts = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    // "." and ".." go before cleaning, which would otherwise make them "_" and "__".
    .filter((s) => !/^\s*\.{1,2}\s*$/.test(s))
    .map(cleanSegment)
    .filter(Boolean);
  return parts.slice(0, 64).join('/') || 'file';
}

/** The common top folder of every path, or null when they do not share one. */
export function commonRoot(paths) {
  let root = null;
  for (const p of paths) {
    const slash = p.indexOf('/');
    if (slash < 0) return null;
    const top = p.slice(0, slash);
    if (root === null) root = top;
    else if (root !== top) return null;
  }
  return root;
}
