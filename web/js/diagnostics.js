// The diagnostics panel: what this browser can do, what the server offered, how each
// connection actually travels, and a network test that explains why a direct connection
// would or would not work from here. "Copy report" gives the lot as text to paste.

import { formatBytes, formatRate } from './util.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Gathers this browser's ICE candidates against the configured servers, without connecting
 * to anyone, and reads the network from them.
 */
export async function runNetworkTest(iceServers, ms = 8000) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.createDataChannel('probe');
  const candidates = [];
  const errors = [];
  const done = new Promise((resolve) => {
    pc.onicecandidate = (e) => {
      if (!e.candidate) return resolve();
      const c = e.candidate;
      candidates.push({
        type: c.type,
        protocol: c.protocol,
        relayProtocol: c.relayProtocol ?? null,
        address: c.address,
        port: c.port,
        relatedPort: c.relatedPort,
        url: e.url ?? null,
      });
    };
    pc.onicecandidateerror = (e) => errors.push({ url: e.url, code: e.errorCode, text: e.errorText });
    setTimeout(resolve, ms);
  });
  await pc.setLocalDescription();
  await done;
  pc.close();
  return { candidates, errors, findings: readNetwork(candidates, errors, iceServers) };
}

/** Plain-language findings from a candidate list. */
export function readNetwork(candidates, errors, iceServers) {
  const out = [];
  const host = candidates.filter((c) => c.type === 'host');
  const srflx = candidates.filter((c) => c.type === 'srflx' && c.protocol === 'udp');
  const relay = candidates.filter((c) => c.type === 'relay');
  const stunCount = iceServers.flatMap((s) => [].concat(s.urls)).filter((u) => u.startsWith('stun')).length;
  if (!host.length) out.push('No local candidates: WebRTC looks disabled or blocked in this browser.');
  else if (host.every((c) => String(c.address ?? '').endsWith('.local'))) {
    out.push(
      'Local addresses are hidden behind mDNS names (Chrome does this). Two devices on one network connect directly only if the network passes multicast DNS; some Wi-Fi (guest networks, client isolation) does not.',
    );
  }
  if (stunCount && !srflx.length) {
    out.push('No public address found: UDP to the STUN servers seems blocked, so direct connections across the internet will fail here.');
  } else if (srflx.length) {
    const byBase = new Map();
    for (const c of srflx) {
      const key = String(c.relatedPort);
      if (!byBase.has(key)) byBase.set(key, new Set());
      byBase.get(key).add(`${c.address}:${c.port}`);
    }
    const symmetric = [...byBase.values()].some((set) => set.size > 1);
    const publicIps = [...new Set(srflx.map((c) => c.address))];
    out.push(`Public address: ${publicIps.join(', ')}.`);
    out.push(
      symmetric
        ? 'This network gives each server a different public port (a symmetric NAT): hole punching usually fails, so connections across the internet will need the relay.'
        : 'This network keeps the same public port for every server: hole punching should work with most other networks.',
    );
  }
  if (relay.length) {
    const protos = [...new Set(relay.map((c) => c.relayProtocol ?? c.protocol))];
    out.push(`TURN reachable (${protos.join(', ')}).`);
  }
  // 701 is reported per address family: a server reachable over IPv4 but not IPv6 logs
  // one too. Only worth a word when nothing came back at all.
  const unreachable = [...new Set(errors.filter((e) => e.code === 701).map((e) => e.url))];
  if (unreachable.length && !srflx.length && !relay.length) out.push(`Could not reach ${unreachable.join(', ')}.`);
  for (const e of errors.filter((e) => e.code !== 701).slice(0, 5)) {
    if (e.code === 401) out.push(`${e.url} refused the credentials (401).`);
    else out.push(`${e.url}: error ${e.code} ${e.text ?? ''}`.trim());
  }
  return out;
}

const ROUTES = {
  lan: 'Direct, same network',
  direct: 'Direct',
  turn: 'Through TURN',
  relay: 'Through the relay',
  'direct+relay': 'Direct, plus relay lanes',
  'turn+relay': 'TURN, plus relay lanes',
};

export function routeLabel(route) {
  return ROUTES[route] ?? 'Not connected';
}

function fmtRtt(s) {
  return typeof s === 'number' ? `${Math.round(s * 1000)} ms` : '–';
}

function describeCandidate(c) {
  if (!c?.type) return '–';
  const proto = c.relayProtocol ?? c.protocol;
  return `${c.type}${proto ? ` (${proto})` : ''}`;
}

/** Everything the panel shows, as one plain object (also what gets copied). */
export async function collectReport(ctx) {
  let storage = null;
  try {
    const e = await navigator.storage?.estimate();
    if (e) storage = { usage: e.usage, quota: e.quota };
  } catch {
    /* not offered */
  }
  const { me, room, version, ice, relay, signalingState, sessions, peers, transfers, settings, lastNetworkTest } = ctx();
  return {
    at: new Date().toISOString(),
    version,
    browser: navigator.userAgent,
    features: {
      folderAccess: 'showDirectoryPicker' in window,
      privateStorage: Boolean(navigator.storage?.getDirectory),
      webrtc: 'RTCPeerConnection' in window,
      wakeLock: 'wakeLock' in navigator,
    },
    storage,
    signaling: { state: signalingState, me: me.id, room, relay, devicesInRoom: peers.length },
    iceServers: (ice.iceServers ?? []).map((s) => ({
      urls: [].concat(s.urls),
      credentials: Boolean(s.username || s.credential),
    })),
    iceExpires: ice.expiresAt ? new Date(ice.expiresAt * 1000).toISOString() : null,
    settings: { maxLinks: settings.maxLinks, limitMBps: settings.limitMBps, boost: settings.boost !== false, forceRelay: Boolean(settings.forceRelay), turnOnly: Boolean(settings.turnOnly) },
    connections: [...sessions.entries()].map(([id, s]) => ({
      device: peers.find((p) => p.id === id)?.name ?? id,
      ...s.diagnostics(),
    })),
    transfers: transfers.slice(-10).map((t) => ({
      direction: t.direction,
      state: t.state,
      bytes: t.total,
      files: t.count,
      seconds: t.startedAt && t.endedAt ? Math.round((t.endedAt - t.startedAt) / 100) / 10 : null,
      route: t.route ?? null,
      error: t.error,
    })),
    networkTest: lastNetworkTest,
  };
}

function section(title, rows) {
  const box = document.createElement('section');
  box.className = 'diag-section';
  const h = document.createElement('h3');
  h.textContent = title;
  box.append(h);
  const dl = document.createElement('dl');
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  box.append(dl);
  return box;
}

/** Wires the dialog. ctx() returns the page's current state; onSetting(name, value) saves. */
export function initDiagnostics(ctx, onSetting) {
  const dlg = $('#diag-dialog');
  const body = $('#diag-body');
  let timer = 0;
  let lastNetworkTest = null;
  const fullCtx = () => ({ ...ctx(), lastNetworkTest });

  const render = async () => {
    const r = await collectReport(fullCtx);
    const parts = [];
    parts.push(
      section('This browser', [
        ['Version', r.version ?? '–'],
        ['Save into a folder', r.features.folderAccess ? 'yes' : 'no (files download one by one)'],
        ['Browser storage', r.storage ? `${formatBytes(r.storage.usage)} used of ${formatBytes(r.storage.quota)}` : '–'],
      ]),
    );
    parts.push(
      section('Server', [
        ['Signaling', r.signaling.state],
        ['Room', r.signaling.room],
        ['Devices in the room', String(r.signaling.devicesInRoom)],
        ['Relay', r.signaling.relay ? 'available' : 'not configured'],
        ['ICE servers', r.iceServers.map((s) => `${s.urls.join(', ')}${s.credentials ? ' (with credentials)' : ''}`).join('\n') || 'none'],
      ]),
    );
    if (!r.connections.length) {
      parts.push(section('Connections', [['', 'None yet. Send something, or receive, to see how it travels.']]));
    }
    for (const c of r.connections) {
      const w = c.webrtc;
      const rows = [
        ['State', c.state + (c.closeReason ? ` (${c.closeReason})` : '')],
        ['Route', routeLabel(c.route)],
        ['Control messages', c.control === 'rtc' ? 'WebRTC' : c.control === 'relay' ? 'relay' : '–'],
      ];
      if (w) {
        rows.push(['WebRTC', `${w.connection}, ICE ${w.ice}`]);
        if (w.path) {
          rows.push(['Path', `you: ${describeCandidate(w.path.local)}, them: ${describeCandidate(w.path.remote)}`]);
          rows.push(['Round trip', fmtRtt(w.path.rtt)]);
          rows.push(['Your candidates', Object.entries(w.path.localCandidates).map(([k, n]) => `${k} ×${n}`).join(', ') || '–']);
          rows.push(['Their candidates', Object.entries(w.path.remoteCandidates).map(([k, n]) => `${k} ×${n}`).join(', ') || '–']);
        }
        if (w.iceErrors.length) rows.push(['ICE errors', w.iceErrors.map((e) => `${e.url} ${e.code} ${e.text ?? ''}`).join('\n')]);
      }
      if (c.relay) rows.push(['Relay session', `${c.relay.session}, ${c.relay.lanes} lane(s)`]);
      rows.push([
        'Lanes',
        c.lanes.map((l) => `${l.lane} ${l.kind}${l.ready ? '' : ' (not ready)'}: ${formatRate(l.rate)}, ${formatBytes(l.queued)} queued`).join('\n') || '–',
      ]);
      rows.push(['Chunk size', formatBytes(c.chunk)]);
      parts.push(section(`Connection: ${c.device}`, rows));
    }
    if (r.transfers.length) {
      parts.push(
        section(
          'Recent transfers',
          r.transfers.map((t) => [
            `${t.direction === 'out' ? 'Sent' : 'Received'} ${formatBytes(t.bytes)}`,
            `${t.state}${t.seconds ? `, ${t.seconds}s, ${formatRate(t.bytes / t.seconds)}` : ''}${t.route ? `, ${routeLabel(t.route)}` : ''}${t.error ? `: ${t.error}` : ''}`,
          ]),
        ),
      );
    }
    if (lastNetworkTest) {
      parts.push(
        section('Network test', [
          ['Findings', lastNetworkTest.findings.join('\n') || '–'],
          [
            'Candidates',
            lastNetworkTest.candidates.map((c) => `${c.type} ${c.relayProtocol ?? c.protocol} ${c.address ?? ''}:${c.port ?? ''}${c.url ? ` via ${c.url}` : ''}`).join('\n') || 'none',
          ],
        ]),
      );
    }
    body.replaceChildren(...parts);
  };

  const open = () => {
    const { settings, relay } = ctx();
    $('#diag-force-relay').checked = Boolean(settings.forceRelay);
    $('#diag-force-relay').disabled = !relay;
    $('#diag-turn-only').checked = Boolean(settings.turnOnly);
    render();
    timer = setInterval(render, 1000);
    dlg.showModal();
  };
  dlg.addEventListener('close', () => clearInterval(timer));

  $('#diag-test').addEventListener('click', async () => {
    const btn = $('#diag-test');
    btn.disabled = true;
    btn.textContent = 'Testing…';
    try {
      lastNetworkTest = await runNetworkTest(ctx().ice.iceServers ?? []);
    } catch (e) {
      lastNetworkTest = { candidates: [], errors: [], findings: [`The test failed: ${e.message}`] };
    }
    btn.disabled = false;
    btn.textContent = 'Run network test';
    render();
  });
  $('#diag-copy').addEventListener('click', async () => {
    const text = JSON.stringify(await collectReport(fullCtx), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      $('#diag-copy').textContent = 'Copied';
      setTimeout(() => ($('#diag-copy').textContent = 'Copy report'), 1500);
    } catch {
      const pre = document.createElement('pre');
      pre.textContent = text;
      body.prepend(pre);
    }
  });
  $('#diag-force-relay').addEventListener('change', (e) => onSetting('forceRelay', e.target.checked));
  $('#diag-turn-only').addEventListener('change', (e) => onSetting('turnOnly', e.target.checked));
  return { open };
}
