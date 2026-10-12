// The relay: WebSocket lanes through the relay Worker (worker/relay.js), for devices that
// cannot connect directly and for transfers a direct connection cannot keep fed.
//
// Everything on a relay lane is encrypted end to end, so the Worker passes ciphertext it
// cannot read. Each device makes an ECDH P-256 key pair per relay session and sends the
// public half through signaling; both derive the same AES-256-GCM key with HKDF. A frame is
//
//   [12-byte nonce: u8 side, u8 lane, 2 pad, u64 counter][AES-GCM ciphertext and tag]
//
// and its plaintext is a transfer message as on a WebRTC lane (DATA, FIN), or a control
// message: [u8 3][UTF-8 JSON]. Encryption and decryption run strictly in order per lane, so
// a lane delivers in order like a WebRTC data channel does, and the receiver refuses a frame
// whose counter does not move forward (a relay replaying or reordering frames).

const enc = new TextEncoder();
const dec = new TextDecoder();

export const T_CTL = 3;
/** Above this much queued, a lane counts as full; it wakes the sender below LOW. */
const LOW = 2 << 20;

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** A key pair for one relay session, and its public half to send to the other device. */
export async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { pair, pub };
}

/** The session's AES-GCM key, from our private key and the other device's public one. */
export async function deriveKey(pair, theirPub, session) {
  const theirs = await crypto.subtle.importKey('raw', unb64url(theirPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, pair.privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(session), info: enc.encode('uploadmyshit relay v1') },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Seals frames for one direction of one lane. */
export class Sealer {
  constructor(key, side, lane) {
    this.key = key;
    this.side = side;
    this.lane = lane;
    this.counter = 0n;
  }

  async seal(plain) {
    const iv = new Uint8Array(12);
    const v = new DataView(iv.buffer);
    v.setUint8(0, this.side);
    v.setUint8(1, this.lane);
    v.setBigUint64(4, ++this.counter);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, plain);
    const frame = new Uint8Array(12 + ct.byteLength);
    frame.set(iv, 0);
    frame.set(new Uint8Array(ct), 12);
    return frame.buffer;
  }
}

/** Opens frames from the other side of one lane, refusing any whose counter goes backwards. */
export class Opener {
  constructor(key, side, lane) {
    this.key = key;
    this.side = side;
    this.lane = lane;
    this.last = 0n;
  }

  async open(frame) {
    if (frame.byteLength < 12 + 16) throw new Error('relay frame too short');
    const iv = new Uint8Array(frame, 0, 12);
    const v = new DataView(frame, 0, 12);
    if (v.getUint8(0) !== this.side || v.getUint8(1) !== this.lane) throw new Error('relay frame for another lane');
    const counter = v.getBigUint64(4);
    if (counter <= this.last) throw new Error('relay frame replayed');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.key, new Uint8Array(frame, 12));
    this.last = counter;
    return plain;
  }
}

export function ctlFrame(text) {
  const body = enc.encode(text);
  const out = new Uint8Array(1 + body.length);
  out[0] = T_CTL;
  out.set(body, 1);
  return out.buffer;
}

export function ctlText(plain) {
  return dec.decode(new Uint8Array(plain, 1));
}

/**
 * One WebSocket through the relay Worker, behaving like a data channel to the transfer code:
 * send(), buffered, ready, in-order delivery. Ready once the other device is connected to
 * the same lane and the session key is known.
 */
export class RelayLane {
  /**
   * ticket: { url, session, role, exp, sig }; key: Promise of the session key;
   * hooks: { onReady(lane), onFrame(lane, plaintext), onClose(lane, why), onDrain() }.
   */
  constructor(ticket, index, key, hooks) {
    this.lid = `r${index}`;
    this.kind = 'relay';
    this.index = index;
    this.hooks = hooks;
    this.paired = false;
    this.key = null;
    this.closed = false;
    this.pending = 0;
    this.sentTotal = 0;
    this.txChain = Promise.resolve();
    this.rxChain = Promise.resolve();
    const mine = ticket.role === 'a' ? 0 : 1;
    const qs = ticket.sig ? `?exp=${ticket.exp}&sig=${encodeURIComponent(ticket.sig)}` : '';
    const ws = new WebSocket(`${ticket.url}/v1/${ticket.session}/${ticket.role}/${index}${qs}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    key.then(
      (k) => {
        this.key = k;
        this.sealer = new Sealer(k, mine, index);
        this.opener = new Opener(k, 1 - mine, index);
        this.#maybeReady();
      },
      (e) => this.close(`no session key: ${e.message}`),
    );
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        if (e.data.includes('"paired"')) {
          this.paired = true;
          this.#maybeReady();
        }
        return;
      }
      const frame = e.data;
      this.rxChain = this.rxChain
        .then(() => this.opener.open(frame))
        .then((plain) => this.hooks.onFrame(this, plain))
        .catch((err) => this.close(`relay: ${err.message}`));
    };
    ws.onclose = (e) => this.close(e.reason || `relay connection closed (${e.code})`);
    ws.onerror = () => {};
    this.drainTimer = setInterval(() => {
      if (this.ready && this.buffered < LOW) this.hooks.onDrain();
    }, 25);
  }

  #maybeReady() {
    if (this.paired && this.key && !this.closed && !this.announced) {
      this.announced = true;
      this.hooks.onReady(this);
    }
  }

  get ready() {
    return this.paired && this.key !== null && !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /** Bytes handed over and not yet on the wire: waiting for encryption, or in the socket. */
  get buffered() {
    return this.pending + (this.ws.bufferedAmount || 0);
  }

  send(buf) {
    if (!this.ready) throw new Error('relay lane not ready');
    const n = buf.byteLength;
    this.pending += n;
    this.sentTotal += n;
    this.txChain = this.txChain
      .then(async () => {
        const frame = await this.sealer.seal(buf);
        this.pending -= n;
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
      })
      .catch((err) => this.close(`relay: ${err.message}`));
  }

  sendCtl(text) {
    this.send(ctlFrame(text));
  }

  close(why = 'closed') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.drainTimer);
    try {
      this.ws.close(1000);
    } catch {
      /* already closed */
    }
    this.hooks.onClose(this, why);
  }
}
