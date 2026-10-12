// Turning what the user dropped or picked into a flat list of { path, file }, and turning
// paths another device sent into ones that are safe to write to disk.

/** OS clutter nobody means to send. */
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized', 'Icon\r']);

/** OS clutter by name, or a macOS "._name" sidecar (resource fork copies on non-Mac disks). */
const ignored = (name) => IGNORED.has(name) || name.startsWith('._');

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
      return { files: plain.filter((f) => !ignored(f.name)).map((file) => ({ path: file.name, file })), dirs: [] };
    }
    const out = { files: [], dirs: [] };
    for (const root of roots) await walk(root, out);
    return uniquePaths(out);
  })();
}

/** Files from an `<input type=file>`, with folder structure when it was a folder pick. */
export function entriesFromInput(fileList) {
  const files = [...fileList]
    .filter((f) => !ignored(f.name))
    .map((file) => ({ path: file.webkitRelativePath || file.name, file }));
  return uniquePaths({ files, dirs: [] });
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
    if (ignored(entry.name)) return;
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.files.push({ path, file });
    return;
  }
  if (!entry.isDirectory) return;
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

/** Windows device names, with or without an extension, and two names Windows reserves. */
const RESERVED = /^((con|prn|aux|nul|com[0-9]|lpt[0-9]|clock\$)(\..*)?|desktop\.ini|thumbs\.db)$/i;
/** Extensions Windows acts on when a folder is opened; Chrome refuses to create them. */
const SHELL_EXTENSIONS = /\.(lnk|local|scf|url|\{[^}]*\})$/i;

/**
 * One file or folder name, made one Chrome will create in a folder the user picked (its
 * File System Access checks are net::IsSafePortablePathComponent): no control or format
 * characters, none of " * / : < > ? \\ | ~, no space or dot at either end, no shell-integrated
 * extension, no Windows reserved name. Unsafe characters become "_" rather than vanishing,
 * so different names stay different.
 */
function cleanSegment(segment) {
  let s = segment
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}"*/:<>?\\|~\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, '_')
    .replace(/^\s+|\s+$/gu, '')
    .replace(/^\.+/, (dots) => '_'.repeat(dots.length))
    .replace(/[.\s]+$/u, '');
  if (s.length > 200) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, 200 - ext.length) + ext;
  }
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
