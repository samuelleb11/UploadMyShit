// UploadMyShit's relay, for devices that cannot connect to each other directly.
//
// Each device opens a WebSocket to /v1/<session>/<a|b>[/<lane>]; the two meet in a Durable
// Object, which passes every frame from one to the other and never looks inside (the page
// encrypts end to end). Devices that can connect directly never come here.
//
// One object per session and lane: an object is single-threaded, so a transfer that opens
// several lanes spreads them over several objects.
//
// With the RELAY_SECRET secret set, a connection needs a ticket the signaling server signed:
// ?exp=<unix seconds>&sig=<base64url HMAC-SHA256 of "<session>.<exp>">. Without it, anyone
// who knows the URL can relay through it.

const PATH = /^\/v1\/([A-Za-z0-9_-]{16,64})\/([ab])(?:\/([0-7]))?$/;
const PAIRED = '{"t":"paired"}';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('uploadmyshit relay\n', { headers: { 'content-type': 'text/plain' } });
    }
    const m = url.pathname.match(PATH);
    if (!m) return new Response('not found\n', { status: 404 });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket\n', { status: 426 });
    }
    const [, session, role, lane = '0'] = m;
    if (env.RELAY_SECRET) {
      const ok = await validTicket(env.RELAY_SECRET, session, url.searchParams.get('exp'), url.searchParams.get('sig'));
      if (!ok) return new Response('forbidden\n', { status: 403 });
    }
    const stub = env.RELAY.get(env.RELAY.idFromName(`${session}/${lane}`));
    return stub.fetch(new Request(`https://relay/${role}`, request));
  },
};

function fromBase64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function validTicket(secret, session, exp, sig) {
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Date.now() / 1000 || !sig) return false;
  let mac;
  try {
    mac = fromBase64url(sig);
  } catch {
    return false;
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  return crypto.subtle.verify('HMAC', key, mac, enc.encode(`${session}.${e}`));
}

export class Relay {
  constructor(ctx) {
    this.ctx = ctx;
    // The open socket for each side. Hibernation wipes memory, so it is looked up again
    // from the runtime whenever it is missing.
    this.peer = new Map();
  }

  #open(role) {
    let ws = this.peer.get(role);
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    ws = this.ctx.getWebSockets(role).find((s) => s.readyState === WebSocket.OPEN) ?? null;
    this.peer.set(role, ws);
    return ws;
  }

  async fetch(request) {
    const role = new URL(request.url).pathname.slice(1);
    // A reconnecting device replaces its earlier socket.
    for (const old of this.ctx.getWebSockets(role)) {
      try {
        old.close(4000, 'replaced');
      } catch {
        /* already closing */
      }
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    this.peer.set(role, server);
    const other = this.#open(role === 'a' ? 'b' : 'a');
    if (other) {
      other.send(PAIRED);
      server.send(PAIRED);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const [role] = this.ctx.getTags(ws);
    const peer = this.#open(role === 'a' ? 'b' : 'a');
    if (peer) peer.send(message);
    // Nobody to hand it to: close rather than swallow it, so the sender sees the lane is
    // gone instead of pouring data into it.
    else ws.close(1011, 'the other device is not connected');
  }

  webSocketClose(ws, code, reason) {
    this.#gone(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  webSocketError(ws) {
    this.#gone(ws, 1011, 'error');
  }

  /** When one side goes, the other is told and closed: a relay is only ever for two. */
  #gone(ws, code, reason) {
    const [role] = this.ctx.getTags(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    if (this.peer.get(role) === ws) this.peer.delete(role);
    const other = this.#open(role === 'a' ? 'b' : 'a');
    if (other && code !== 4000) {
      try {
        other.close(1000, 'the other device left');
      } catch {
        /* already closing */
      }
    }
  }
}
