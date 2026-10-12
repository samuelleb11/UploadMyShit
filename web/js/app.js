// The page: devices around you, drop files on one to send, accept what others send.

import { Signaling } from './signaling.js';
import { PeerSession } from './peer.js';
import { entriesFromDrop, entriesFromInput, commonRoot } from './files.js';
import {
  canPickFolder,
  chooseDestination,
  destinationName,
  ensureDestination,
  initStorage,
  storageMode,
} from './sink.js';
import {
  TokenBucket,
  describeDevice,
  formatBytes,
  formatDuration,
  formatRate,
  hueFor,
  randomRoomCode,
  randomToken,
} from './util.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

// ---- settings and identity ---------------------------------------------------------

const SETTINGS_KEY = 'ums.settings';
const settings = Object.assign(
  { name: '', limitMBps: 0, maxLinks: 'auto' },
  (() => {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  })(),
);
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

/** Per tab: a reload keeps the same id, a second tab is a second device. */
function tabSecret(renew = false) {
  let s = sessionStorage.getItem('ums.secret');
  if (!s || renew) {
    s = randomToken(24);
    sessionStorage.setItem('ums.secret', s);
  }
  return s;
}

const device = describeDevice();
const limiter = new TokenBucket(settings.limitMBps * 1e6);

function roomFromUrl() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{4,64})\/?$/);
  return m ? m[1].toLowerCase() : null;
}

let room = roomFromUrl();
let me = { id: null, name: settings.name };
let ice = { iceServers: [] };
let iceWaiters = [];
const peers = new Map(); // id -> { info, el }
const sessions = new Map(); // id -> PeerSession
const transfers = new Map(); // key -> { t, card, peerId }
const offerQueue = [];

// ---- signaling ---------------------------------------------------------------------

const signaling = new Signaling(() => ({
  t: 'hello',
  secret: tabSecret(),
  room,
  name: settings.name || undefined,
  device,
}));

signaling.on('state', (state) => {
  const status = $('#status');
  status.dataset.state = state;
  $('#status-text').textContent =
    state === 'ready' ? 'Connected' : state === 'connecting' ? 'Connecting…' : 'Offline, reconnecting…';
});

signaling.on('welcome', (m) => {
  me = { id: m.id, name: m.name };
  ice = m.ice;
  if (!settings.name) {
    settings.name = m.name;
    saveSettings();
  }
  $('#me-name').textContent = m.name;
  $('#version').textContent = `v${m.version}`;
  for (const id of [...peers.keys()]) removePeer(id);
  for (const p of m.peers) addPeer(p);
  renderRoom(m.room);
  renderHint();
});

signaling.on('peer-joined', (m) => addPeer(m.peer));
signaling.on('peer-left', (m) => removePeer(m.id));
signaling.on('peer-updated', (m) => {
  if (m.peer.id === me.id) {
    me.name = m.peer.name;
    $('#me-name').textContent = m.peer.name;
  } else if (peers.has(m.peer.id)) {
    peers.get(m.peer.id).info = m.peer;
    renderPeer(m.peer.id);
  }
});
signaling.on('signal', (m) => session(m.from).handleSignal(m.data));
signaling.on('ice', (m) => {
  ice = m.ice;
  for (const r of iceWaiters.splice(0)) r(ice);
});
signaling.on('bye', (m) => {
  // Another tab took over this tab's identity (a duplicated tab copies it): become new.
  if (m.reason === 'replaced') {
    tabSecret(true);
    signaling.restart();
  }
});
signaling.on('error', (m) => {
  if (m.code === 'room-full') toast('That room is full.');
  else if (m.code === 'bad-room') {
    toast('That room code is not valid.');
    goToRoom(null);
  } else if (m.code !== 'unknown-peer') console.warn('server:', m.code, m.message);
});

/** ICE servers, refreshed first when TURN credentials are about to expire. */
async function getIce() {
  if (ice.expiresAt && ice.expiresAt * 1000 - Date.now() < 10 * 60_000 && signaling.state === 'ready') {
    signaling.send({ t: 'get-ice' });
    await Promise.race([new Promise((r) => iceWaiters.push(r)), new Promise((r) => setTimeout(r, 3000))]);
  }
  return { iceServers: ice.iceServers };
}

// ---- devices -----------------------------------------------------------------------

function session(peerId) {
  let s = sessions.get(peerId);
  if (s && s.state !== 'closed') return s;
  s = new PeerSession({ localId: me.id, remoteId: peerId, signaling, getIce, settings, limiter });
  sessions.set(peerId, s);
  s.on('transfer', (t) => addTransfer(t, peerId));
  s.on('offer', (t) => queueOffer(t));
  s.on('state', () => renderPeer(peerId));
  s.on('closed', () => {
    if (sessions.get(peerId) === s) sessions.delete(peerId);
    renderPeer(peerId);
  });
  return s;
}

function peerName(id) {
  return peers.get(id)?.info.name ?? sessions.get(id)?.lastName ?? 'a device';
}

function addPeer(info) {
  if (info.id === me.id) return;
  if (peers.has(info.id)) {
    peers.get(info.id).info = info;
    renderPeer(info.id);
    return;
  }
  const li = el('li');
  const btn = el('button', 'peer entering');
  btn.type = 'button';
  btn.dataset.id = info.id;
  const avatar = el('span', 'avatar');
  avatar.style.setProperty('--hue', hueFor(info.id));
  avatar.innerHTML =
    '<svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-fg" r="46" cx="50" cy="50"/></svg>';
  avatar.append(icon('laptop'));
  btn.append(avatar, el('span', 'name'), el('span', 'meta'), el('span', 'badge'));
  btn.addEventListener('click', () => openSend(info.id));
  btn.addEventListener('animationend', () => btn.classList.remove('entering'), { once: true });
  li.append(btn);
  peers.set(info.id, { info, el: btn });
  renderPeer(info.id);
  // Placed before it is in the page, so it appears at its spot instead of sliding out of
  // the middle.
  layout();
  $('#peers').append(li);
  renderHint();
}

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.el.parentElement.remove();
  peers.delete(id);
  const s = sessions.get(id);
  if (s) s.lastName = p.info.name;
  // A device that left the room may still be mid-transfer: browser to browser, that
  // carries on. An idle connection is closed.
  if (s && !s.busy) s.close('left the room');
  layout();
  renderHint();
}

const ICON_FOR = { phone: 'phone', tablet: 'tablet', desktop: 'laptop' };

function renderPeer(id) {
  const p = peers.get(id);
  if (!p) return;
  const { info, el: btn } = p;
  btn.querySelector('.name').textContent = info.name;
  btn.querySelector('.meta').textContent = [info.device.os, info.device.browser].filter(Boolean).join(' · ');
  btn.querySelector('.avatar use').setAttribute('href', `#i-${ICON_FOR[info.device.kind] ?? 'laptop'}`);
  btn.setAttribute('aria-label', `Send to ${info.name}`);
  const s = sessions.get(id);
  const badge = btn.querySelector('.badge');
  const path = s?.state === 'connected' ? s.path : null;
  badge.hidden = !path && s?.state !== 'connecting';
  badge.dataset.path = path ?? '';
  badge.textContent = s?.state === 'connecting' ? 'connecting' : { lan: 'LAN', direct: 'Direct', relay: 'Relayed' }[path] ?? '';
  // Ring: progress of everything in flight with this device.
  let total = 0;
  let done = 0;
  for (const { t, peerId } of transfers.values()) {
    if (peerId !== id || t.terminal || t.state === 'pending' || t.state === 'queued') continue;
    total += t.total;
    done += t.written;
  }
  const fg = btn.querySelector('.ring-fg');
  fg.style.strokeDashoffset = String(289 * (1 - (total ? done / total : 0)));
  fg.style.opacity = total ? '1' : '0';
}

function layout() {
  const field = $('#field').getBoundingClientRect();
  const items = [...peers.values()].map((p) => p.el);
  const n = items.length;
  // Each device is about 130 px wide and 120 px tall around its centre: keep it inside.
  const rx = Math.max(100, Math.min(field.width / 2 - 70, 330));
  const ry = Math.max(95, Math.min(field.height / 2 - 84, 230));
  items.forEach((item, i) => {
    const a = -Math.PI / 2 + (i / Math.max(n, 1)) * Math.PI * 2;
    const ring = n > 8 && i % 2 ? 0.6 : 1;
    item.style.setProperty('--x', `${Math.cos(a) * rx * ring}px`);
    item.style.setProperty('--y', `${Math.sin(a) * ry * ring}px`);
  });
}
// The field shrinks as transfer cards appear, not only when the window resizes.
new ResizeObserver(() => layout()).observe($('#field'));

/** The line under the devices, with the buttons that fit the moment: on your own, the way
 * to reach another device is right there rather than behind the room chip. */
function renderHint() {
  const text = $('#hint-text');
  const actions = $('#hint-actions');
  actions.replaceChildren();
  const add = (label, onClick, cls = 'btn') => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    actions.append(b);
  };
  if (room && peers.size) {
    text.textContent = 'Drop files or folders on a device, or click it to choose them.';
    add('Invite another device', () => openRoomDialog(), 'link-btn');
  } else if (room) {
    text.textContent =
      'You are in a private room. Open its link on the other device, or scan its QR code, and it appears here.';
    add('Copy link', copyRoomLink, 'btn primary');
    add('Show QR code', () => openRoomDialog());
    add('Leave room', () => goToRoom(null));
  } else if (peers.size) {
    text.textContent = 'Drop files or folders on a device, or click it to choose them.';
    add('Device somewhere else? Create a private room', createRoom, 'link-btn');
  } else {
    text.textContent =
      roomKind === 'none'
        ? 'Create a private room, or join one, to connect with another device.'
        : 'Devices on your network appear here on their own. To reach a device anywhere else, use a private room.';
    add('Create a private room', createRoom, 'btn primary');
    add('Join with a code', () => openRoomDialog(true));
  }
}

// ---- rooms -------------------------------------------------------------------------

let roomKind = 'network';

function renderRoom(info) {
  roomKind = info.kind;
  const btn = $('#room-btn');
  btn.dataset.private = String(info.kind === 'private');
  btn.querySelector('use').setAttribute('href', info.kind === 'private' ? '#i-link' : '#i-wifi');
  $('#room-label').textContent =
    info.kind === 'private' ? `Room ${info.code}` : info.kind === 'network' ? 'Your network' : 'Not in a room';
  $('#room-action-label').textContent = info.kind === 'private' ? 'Invite' : 'New room';
  $('#room-action').setAttribute(
    'aria-label',
    info.kind === 'private' ? 'Invite a device to this room' : 'Create a private room',
  );
  updateTitle();
  renderHint();
}

/** The room the page is about to join, shown at once rather than when the server confirms. */
function expectRoom() {
  renderRoom(room ? { kind: 'private', code: room } : { kind: roomKind === 'private' ? 'network' : roomKind });
}

function goToRoom(code) {
  room = code;
  history.pushState(null, '', code ? `/r/${code}` : '/');
  for (const id of [...peers.keys()]) removePeer(id);
  expectRoom();
  signaling.restart();
}

addEventListener('popstate', () => {
  room = roomFromUrl();
  for (const id of [...peers.keys()]) removePeer(id);
  expectRoom();
  signaling.restart();
});

const roomLink = () => `${location.origin}/r/${room}`;

/** A room code from what the user typed: the code itself, or a whole room link. */
function parseRoom(input) {
  const s = input.trim();
  const m = s.match(/\/r\/([A-Za-z0-9_-]{4,64})\/?(?:[?#].*)?$/);
  const code = (m ? m[1] : s).toLowerCase();
  return /^[a-z0-9_-]{4,64}$/.test(code) ? code : null;
}

function openRoomDialog(focusJoin = false) {
  $('#room-network').hidden = Boolean(room);
  $('#room-private').hidden = !room;
  if (room) {
    $('#room-code-label').textContent = room;
    $('#room-link').value = roomLink();
    $('#room-qr').src = `/api/qr?d=${encodeURIComponent(roomLink())}`;
  }
  const dlg = $('#room-dialog');
  if (!dlg.open) dlg.showModal();
  if (focusJoin && !room) $('#room-code').focus();
}

/** Opens a new private room, shows its link and QR code, and copies the link. */
async function createRoom() {
  goToRoom(randomRoomCode());
  openRoomDialog();
  try {
    await navigator.clipboard.writeText(roomLink());
    toast('Private room created, link copied. Open it on the other device.');
  } catch {
    toast('Private room created. Open its link on the other device.');
  }
}

async function copyRoomLink() {
  try {
    await navigator.clipboard.writeText(roomLink());
    toast('Link copied.');
  } catch {
    openRoomDialog();
    $('#room-link').select();
  }
}

$('#room-btn').addEventListener('click', () => openRoomDialog());
$('#room-action').addEventListener('click', () => (room ? openRoomDialog() : createRoom()));
$('#room-create').addEventListener('click', createRoom);
$('#room-join').addEventListener('click', () => {
  const code = parseRoom($('#room-code').value);
  if (!code) {
    toast('Paste the room’s link, or type its code (4 to 64 letters, digits, - or _).');
    return;
  }
  $('#room-code').value = '';
  $('#room-dialog').close();
  goToRoom(code);
});
$('#room-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#room-join').click();
  }
});
$('#room-copy').addEventListener('click', copyRoomLink);
$('#room-leave').addEventListener('click', () => {
  $('#room-dialog').close();
  goToRoom(null);
});

// ---- sending -----------------------------------------------------------------------

let sendTarget = null;

function openSend(peerId) {
  sendTarget = peerId;
  $('#send-title').textContent = `Send to ${peerName(peerId)}`;
  $('#send-dialog').showModal();
}

$('#send-files').addEventListener('click', () => $('#pick-files').click());
$('#send-folder').addEventListener('click', () => $('#pick-folder').click());
for (const input of [$('#pick-files'), $('#pick-folder')]) {
  input.addEventListener('change', () => {
    const picked = entriesFromInput(input.files);
    input.value = '';
    $('#send-dialog').close();
    if (sendTarget) sendTo(sendTarget, picked.files, picked.dirs);
  });
}

function sendTo(peerId, files, dirs = []) {
  if (!files.length && !dirs.length) {
    toast('Nothing to send: the folder is empty.');
    return null;
  }
  return session(peerId).send(files, dirs);
}

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

function dropTargetAt(e) {
  const hit = e.target instanceof Element ? e.target.closest('.peer') : null;
  if (hit) return hit.dataset.id;
  return peers.size === 1 ? [...peers.keys()][0] : null;
}

addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dragging');
  $('#drop-hint').hidden = false;
});
addEventListener('dragleave', () => {
  if (--dragDepth > 0) return;
  dragDepth = 0;
  document.body.classList.remove('dragging');
  $('#drop-hint').hidden = true;
});
addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const target = dropTargetAt(e);
  e.dataTransfer.dropEffect = target ? 'copy' : 'none';
  for (const [id, p] of peers) p.el.classList.toggle('drop-target', id === target);
  $('#drop-hint').textContent = target ? `Send to ${peerName(target)}` : 'Drop on a device to send';
});
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  $('#drop-hint').hidden = true;
  for (const p of peers.values()) p.el.classList.remove('drop-target');
  const target = dropTargetAt(e);
  if (!target) {
    toast(peers.size ? 'Drop the files on the device to send them to.' : 'No device to send to yet.');
    return;
  }
  // Taken synchronously: the browser empties the drop data once this handler returns.
  entriesFromDrop(e.dataTransfer)
    .then(({ files, dirs }) => sendTo(target, files, dirs))
    .catch((err) => toast(`Could not read what was dropped: ${err.message}`));
});

// ---- receiving ---------------------------------------------------------------------

/** Tests set this to accept without the dialog: (transfer) => accept options. */
let autoAccept = null;

function queueOffer(t) {
  if (autoAccept) {
    Promise.resolve(autoAccept(t))
      .then((opts) => t.accept(opts))
      .catch((e) => console.error('auto-accept failed', e));
    return;
  }
  offerQueue.push(t);
  t.on('state', () => {
    if (t.state === 'pending') return;
    const i = offerQueue.indexOf(t);
    if (i < 0) return;
    offerQueue.splice(i, 1);
    if (i === 0 && $('#offer-dialog').open) {
      $('#offer-dialog').close();
      if (t.state === 'cancelled') toast(`${peerName(t.session.remoteId)} cancelled.`);
    }
    showOffer();
  });
  updateTitle();
  showOffer();
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('UploadMyShit', { body: `${peerName(t.session.remoteId)} wants to send you ${describeBatch(t)}.` });
  }
}

function describeBatch(t) {
  const what = t.count === 1 ? t.files[0].path.split('/').pop() : `${t.count} files`;
  return `${what} (${formatBytes(t.total)})`;
}

function showOffer() {
  updateTitle();
  const dlg = $('#offer-dialog');
  if (dlg.open || !offerQueue.length) return;
  const t = offerQueue[0];
  $('#offer-title').textContent = `${peerName(t.session.remoteId)} wants to send you files`;
  const folders = t.dirs.length ? `, ${t.dirs.length} empty folder${t.dirs.length > 1 ? 's' : ''}` : '';
  $('#offer-summary').textContent = `${t.count} file${t.count === 1 ? '' : 's'}${folders}, ${formatBytes(t.total)} in all.`;
  const list = $('#offer-files');
  list.replaceChildren();
  for (const f of t.files.slice(0, 200)) {
    const li = el('li');
    li.append(el('span', '', f.path), el('span', '', formatBytes(f.size)));
    list.append(li);
  }
  if (t.files.length > 200) list.append(el('li', '', `and ${t.files.length - 200} more`));
  renderDestination();
  dlg.showModal();
}

async function renderDestination() {
  $('#offer-dest').hidden = !canPickFolder;
  const note = $('#offer-note');
  note.hidden = true;
  if (canPickFolder) {
    $('#offer-dest-name').textContent = destinationName() ?? 'a folder you choose';
    return;
  }
  const t = offerQueue[0];
  const opfs = await storageMode();
  note.hidden = false;
  note.textContent =
    t?.count > 1
      ? 'This browser cannot write into a folder, so each file downloads on its own as soon as it arrives. Chrome on a computer saves the whole thing, folders included, into a folder you choose.'
      : 'The file downloads as soon as it arrives.';
  if (!opfs && t?.total > 1.5e9) note.textContent += ' This browser will hold it in memory until then.';
  const free = await freeStorage();
  if (opfs && free !== null && t && free < t.total) {
    note.textContent += ` This browser has only ${formatBytes(free)} of storage free for it, so it will likely stop partway.`;
  }
}

/** Bytes this site may still store, or null when the browser does not say. */
async function freeStorage() {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return Number.isFinite(quota) ? Math.max(0, quota - (usage || 0)) : null;
  } catch {
    return null;
  }
}

$('#offer-change').addEventListener('click', async () => {
  try {
    await chooseDestination();
    renderDestination();
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message);
  }
});

$('#offer-accept').addEventListener('click', async () => {
  const t = offerQueue[0];
  if (!t) return;
  try {
    // First await in the click: the folder permission needs the user's gesture.
    const opts = canPickFolder ? { mode: 'dir', dir: await ensureDestination() } : { mode: (await storageMode()) ? 'opfs' : 'mem' };
    offerQueue.shift();
    $('#offer-dialog').close();
    showOffer();
    await t.accept(opts);
  } catch (e) {
    if (e.name === 'AbortError') return; // closed the folder picker: still undecided
    toast(`Could not accept: ${e.message}`);
  }
});

$('#offer-decline').addEventListener('click', () => {
  const t = offerQueue.shift();
  $('#offer-dialog').close();
  t?.decline();
  showOffer();
});

$('#offer-dialog').addEventListener('cancel', (e) => e.preventDefault());

function updateTitle() {
  document.title = offerQueue.length ? `(${offerQueue.length}) UploadMyShit` : 'UploadMyShit';
}

// ---- transfer cards ----------------------------------------------------------------

const STATE_TEXT = {
  queued: 'Queued',
  offered: 'Waiting for them to accept',
  pending: 'Waiting for you',
  accepting: 'Starting…',
  sending: 'Sending',
  receiving: 'Receiving',
  verifying: 'Finishing…',
  finishing: 'Finishing…',
  done: 'Done',
  declined: 'Declined',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

function addTransfer(t, peerId) {
  const key = `${t.direction}:${peerId}:${t.tn}`;
  const card = el('article', 'transfer');
  const head = el('div', 't-head');
  head.append(icon(t.direction === 'out' ? 'up' : 'down'), el('strong'), el('span', 't-state'));
  const btn = el('button', 't-btn', 'Cancel');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    if (t.terminal) {
      t.release?.();
      card.remove();
      transfers.delete(key);
    } else {
      t.cancel();
    }
  });
  head.append(btn);
  const root = commonRoot(t.files.map((f) => f.path));
  const title = t.count === 1 ? t.files[0].path : root ? `${root}/ (${t.count} files)` : `${t.count} files`;
  const bar = el('div', 'bar');
  bar.append(el('div', 'fill'));
  card.append(head, el('div', 't-title', title), bar, el('div', 't-stats'), el('div', 't-error'), el('ul', 't-files'));
  $('#transfers').prepend(card);
  const entry = { t, card, peerId, recent: [] };
  transfers.set(key, entry);
  t.on('change', () => (entry.dirty = true));
  t.on('state', () => {
    renderTransfer(entry);
    renderPeer(peerId);
    keepAwake();
    if (t.state === 'done' && t.direction === 'in' && t.mode === 'dir') {
      toast(`Saved ${t.count === 1 ? t.files[0].path.split('/').pop() : `${t.count} files`} to ${t.destination}.`);
    }
    if (t.state === 'declined' && t.direction === 'out') toast(`${peerName(peerId)} declined.`);
  });
  t.on('file', (f) => {
    entry.recent.unshift(f.path);
    entry.recent.length = Math.min(entry.recent.length, 3);
  });
  renderTransfer(entry);
  keepAwake();
}

function renderTransfer({ t, card, peerId, recent }) {
  card.dataset.state = t.state;
  const name = peerName(peerId);
  card.querySelector('strong').textContent = t.direction === 'out' ? `To ${name}` : `From ${name}`;
  card.querySelector('.t-state').textContent = STATE_TEXT[t.state] ?? t.state;
  card.querySelector('.t-btn').textContent = t.terminal ? 'Clear' : t.state === 'pending' ? 'Decline' : 'Cancel';
  const pct = t.total ? (t.written / t.total) * 100 : t.state === 'done' ? 100 : 0;
  card.querySelector('.fill').style.width = `${Math.min(100, pct)}%`;
  const stats = [`${formatBytes(t.written)} of ${formatBytes(t.total)}`];
  const running = t.state === 'sending' || t.state === 'receiving';
  if (running) {
    stats.push(formatRate(t.speed));
    if (t.eta != null) stats.push(`${formatDuration(t.eta)} left`);
  } else if (t.state === 'done' && t.startedAt && t.endedAt) {
    const secs = (t.endedAt - t.startedAt) / 1000;
    stats.push(`in ${formatDuration(secs)}, ${formatRate(t.total / Math.max(secs, 0.001))} average`);
  }
  if (t.count > 1) stats.push(`${t.filesDone}/${t.count} files`);
  const s = t.session;
  if (running && s.state === 'connected') {
    const n = s.openLanes().length;
    const path = { lan: 'LAN', direct: 'direct', relay: 'relayed' }[s.path] ?? '';
    stats.push(`${n} connection${n === 1 ? '' : 's'}${path ? `, ${path}` : ''}`);
  }
  if (t.direction === 'in' && t.destination && t.state !== 'pending') stats.push(`into ${t.destination}`);
  card.querySelector('.t-stats').textContent = stats.join('  ·  ');
  card.querySelector('.t-error').textContent = t.state === 'failed' || t.state === 'cancelled' ? (t.error ?? '') : '';
  const files = card.querySelector('.t-files');
  if (t.direction === 'in' && recent.length && files.dataset.shown !== recent.join('\n')) {
    files.dataset.shown = recent.join('\n');
    files.replaceChildren(
      ...recent.map((p) => {
        const li = el('li');
        li.append(icon('check'), el('span', '', p));
        return li;
      }),
    );
  }
}

setInterval(() => {
  for (const entry of transfers.values()) {
    if (!entry.dirty) continue;
    entry.dirty = false;
    renderTransfer(entry);
    renderPeer(entry.peerId);
  }
}, 250);

// ---- staying awake, not losing a transfer to a closed tab --------------------------

let wakeLock = null;

function activeCount() {
  let n = 0;
  for (const { t } of transfers.values()) if (!t.terminal && t.state !== 'pending' && t.state !== 'queued') n++;
  return n;
}

async function keepAwake() {
  const want = activeCount() > 0;
  if (want && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch {
      /* refused, e.g. low battery */
    }
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', keepAwake);

addEventListener('beforeunload', (e) => {
  if (activeCount() > 0) e.preventDefault();
});

// ---- settings ----------------------------------------------------------------------

function openSettings(focusName = false) {
  $('#set-name').value = settings.name || me.name || '';
  $('#set-limit').value = String(settings.limitMBps || 0);
  $('#set-links').value = String(settings.maxLinks);
  $('#set-dest-field').hidden = !canPickFolder;
  $('#set-dest').textContent = destinationName() ?? 'Not chosen yet';
  $('#settings-dialog').showModal();
  if (focusName) $('#set-name').select();
}

$('#settings-btn').addEventListener('click', () => openSettings());
$('#me').addEventListener('click', () => openSettings(true));
$('#set-name').addEventListener('change', () => {
  const name = $('#set-name').value.trim().replace(/\s+/g, ' ').slice(0, 32);
  if (!name) return;
  settings.name = name;
  saveSettings();
  signaling.send({ t: 'rename', name });
});
$('#set-limit').addEventListener('change', () => {
  settings.limitMBps = Math.max(0, Number($('#set-limit').value) || 0);
  limiter.setRate(settings.limitMBps * 1e6);
  saveSettings();
});
$('#set-links').addEventListener('change', () => {
  settings.maxLinks = $('#set-links').value;
  saveSettings();
});
$('#set-dest-change').addEventListener('click', async () => {
  try {
    await chooseDestination();
    $('#set-dest').textContent = destinationName() ?? 'Not chosen yet';
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message);
  }
});

// ---- toasts ------------------------------------------------------------------------

function toast(text) {
  const t = el('div', 'toast', text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

// ---- start -------------------------------------------------------------------------

$('#me-name').textContent = settings.name || '…';
$('#me-avatar use').setAttribute('href', `#i-${ICON_FOR[device.kind] ?? 'laptop'}`);
renderHint();
initStorage().catch((e) => console.warn('storage', e));
signaling.start();

// For the end-to-end tests, and for anyone poking at it from the console.
window.__ums = {
  get me() {
    return me;
  },
  peers: () => [...peers.values()].map((p) => p.info),
  sessions,
  transfers: () => [...transfers.values()].map((e) => e.t),
  send: (peerId, files, dirs) => sendTo(peerId, files, dirs),
  setAutoAccept: (fn) => {
    autoAccept = fn;
  },
  settings,
  limiter,
};
