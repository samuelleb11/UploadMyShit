# Protocol

The wire formats between the page, the server and the relay. [architecture.md](architecture.md)
explains why they look this way.

- [Signaling](#signaling): page ⇄ server, JSON over `/ws`
- [Signals between devices](#signals-between-devices): what pages put in a `signal`
- [Relay](#relay): tickets, the Worker's URL, encrypted frames
- [Transfers](#transfers): binary frames on data lanes, JSON control messages

## Signaling

One WebSocket per tab at `/ws`. The server refuses connections whose `Origin` isn't its
own. Every message is a JSON object whose `t` field names its type. Protocol version: `1`.

### Page → server

| `t` | Fields | |
| --- | --- | --- |
| `hello` | `secret`, `room?`, `name?`, `device?`, `page?` | Must be the first message. |
| `signal` | `to`, `data` | Passed to device `to` in the same room, unread. |
| `rename` | `name` | |
| `get-ice` | | Fresh ICE servers, when TURN credentials near expiry. |
| `relay` | `to`, `sid?`, `rsid?` | Asks for a relay session with `to`. |
| `ping` | | Keep-alive, every 20 s. Browsers can't see WebSocket pings. |

The `hello` fields:
- **`secret`**: 16 to 128 of `A-Z a-z 0-9 - _`, random per tab and kept in the tab's
  session storage. The device id is derived from it, so a reconnecting tab keeps its id
  and nobody else can claim it.
- **`room`**: a private room's code. When absent, the device joins its network room.
- **`device`**: `{kind, os, browser}`.
- **`page`**: the asset version the page's scripts came from.

### Server → page

| `t` | Fields | |
| --- | --- | --- |
| `welcome` | `protocol`, `version`, `assets`, `id`, `name`, `room`, `ice`, `relay`, `peers` | The reply to `hello` |
| `peer-joined` | `peer` | |
| `peer-left` | `id` | |
| `peer-updated` | `peer` | Renamed |
| `signal` | `from`, `data` | |
| `ice` | `ice` | The reply to `get-ice` |
| `relay` | `peer`, `url`, `session`, `role`, `exp`, `sig?`, `sid?`, `rsid?` | A relay ticket |
| `pong` | | |
| `error` | `code`, `message` | |
| `bye` | `reason` | The server is closing this connection |

The `welcome` fields:
- **`assets`**: the asset version the server serves now. A page whose scripts came from
  another version reloads.
- **`room`**: one of
  - `{"kind":"network"}`;
  - `{"kind":"private","code":…}`;
  - `{"kind":"none"}`: network rooms are off;
  - `{"kind":"address-unknown"}`: the server can't see this visitor's real address.
- **`ice`**: the `RTCConfiguration.iceServers` to use.
- **`relay`**: whether a relay Worker is configured.

A `peer` is `{id, name, device, page?}`, where `page` is the version that device's page
runs.

A `relay` ticket goes to both devices, with `role` `a` for one and `b` for the other.
`sid` and `rsid` echo the requesting page's connection ids, so each page can tell a ticket
for its current connection from a stale one.

`bye` reasons:
- **`replaced`**: the same tab connected again.
- **`restart`**: the server is stopping; reconnect.

Error codes:

| Code | |
| --- | --- |
| `bad-hello` | The first message wasn't a valid `hello`. The connection closes. |
| `bad-room` | The room code isn't 4 to 64 of `a-z 0-9 - _`. The connection closes. |
| `already-greeted` | A second `hello` |
| `bad-message` | Unparseable, or an unknown `t` |
| `bad-name` | A `rename` the server won't accept |
| `unknown-peer` | `to` isn't in this room |
| `no-relay` | `relay` was asked for, but none is configured |
| `rate-limited` | Too many messages; repeated overruns close the connection |
| `server-full`, `too-many-connections`, `room-full` | A limit was reached |

## Signals between devices

The `data` of a `signal` is the pages' own business; the server only checks that its
recipient is in the same room. Every signal carries the sender's connection id `sid` and,
once known, the receiver's `rsid`. A page drops a signal meant for a connection it has
since replaced.

| `data.k` | Fields | |
| --- | --- | --- |
| `sdp` | `d` | An `RTCSessionDescription`, offer or answer |
| `ice` | `c` | An ICE candidate |
| `relay-please` | | "Ask the server for a relay session." Sent by the impolite side; only the polite side asks the server, so requests never cross. |
| `relay-key` | `session`, `pub` | This device's ECDH P-256 public key for the relay session, raw, base64url |

## Relay

### Connecting

The server mints a session id: 16 random bytes, base64url. The ticket's
`sig = base64url(HMAC-SHA256(secret, "<session>.<exp>"))`, with no padding. The Worker
checks it with the same secret, its `RELAY_SECRET`. Each device then connects to:

```
<url>/v1/<session>/<role>/<lane>?exp=<exp>&sig=<sig>
```

- `role` is `a` or `b`.
- `lane` is `0`–`7` (`/<lane>` may be left out for lane 0).
- Each `(session, lane)` gets its own Durable Object.
- Once both sides of a lane are connected, the Worker sends each one `{"t":"paired"}`.

The Worker's close codes:

| Code | When |
| --- | --- |
| `4000 replaced` | The same role connected again |
| `1011 the other device is not connected` | A frame arrived while the other side was gone. The relay closes rather than swallow data. |
| `1000 the other device left` | The other side closed |

Without `RELAY_SECRET` the Worker checks no tickets. It answers `403` to a bad or expired
ticket, and `426` to a request that isn't a WebSocket upgrade.

### Encryption

Each device makes an ECDH P-256 key pair per relay session and sends the public half as a
`relay-key` signal. Both derive the session key:

```
shared = ECDH(my private key, their public key)
key    = HKDF-SHA256(shared, salt = UTF-8(session), info = "uploadmyshit relay v1") → AES-256-GCM
```

Every frame on a relay lane is:

```
[12-byte nonce: u8 side, u8 lane, 2 bytes zero, u64 counter, big-endian][AES-GCM ciphertext + tag]
```

Encryption and decryption run strictly in order per lane. The receiver refuses a frame
whose counter doesn't move forward, or whose side or lane is wrong. A replayed,
reordered or misdirected frame fails.

The plaintext is either a transfer frame, exactly as on a WebRTC lane (below), or a
control message: `[u8 3][UTF-8 JSON]`.

## Transfers

Each device pair has one ordered control channel:
- the WebRTC `ctl` data channel (id 0) while there is a direct connection;
- relay control frames otherwise.

File bytes go on data lanes: the WebRTC `data` channel (id 1) of each connection, and each
relay lane.

### Data-lane frames

All integers are big-endian u32. Each frame has a 16-byte header:

```
DATA  [u8 1][3 pad][tn][file][chunk]  payload
FIN   [u8 2][3 pad][tn][pass][4 pad]
```

- **`tn`**: the transfer number.
- **`file`**: the file's index in the offer.
- **`chunk`**: the chunk's index within that file.
- **Chunk size**: the offer's `chunk` value. It is at most 256 KB, in multiples of 4 KB,
  and within the connection's maximum message size.
- **`FIN`** means every byte this lane carried in pass `pass` has gone out. Lanes are
  ordered, so data before a FIN has been delivered.

### Control messages

JSON on the control channel. A message longer than 16,000 characters is split into
`{"t":"frag","id","i","n","d"}` parts and reassembled.

Transfer messages (sender → receiver):

| `t` | Fields | |
| --- | --- | --- |
| `offer` | `tn`, `chunk`, `total`, `files: [{p, s, m, y}]`, `dirs` | `p` path, `s` size, `m` last modified (ms), `y` MIME type; `dirs` are empty folders |
| `sent` | `tn`, `pass`, `lanes` | Which lanes will each send a FIN for this pass |
| `abort` | `tn` | The sender cancelled |

Transfer messages (receiver → sender):

| `t` | Fields | |
| --- | --- | --- |
| `accept` | `tn`, `window` | The credit window in bytes. The sender clamps it to 4–256 MB. |
| `decline` | `tn` | |
| `ack` | `tn`, `r`, `w`, `u`, `d`, `f` | Every 100 ms; see below |
| `resend` | `tn`, `pass`, `ranges` | Chunks still missing after every lane's FIN; the sender starts the next pass with them |
| `done` | `tn` | Everything written |
| `stop` | `tn`, `reason?` | The receiver cancelled, or its disk failed |

The `ack` fields:
- `r`: bytes received per lane;
- `w`: bytes written, counting duplicates;
- `u`: bytes received;
- `d`: bytes written;
- `f`: files completed.

Session messages, which aren't tied to a transfer:

| `t` | Fields | |
| --- | --- | --- |
| `link` | `op` (`offer`, `answer`, `cand`, `close`), `lid`, `sdp?`, `c?` | Negotiates an extra WebRTC connection over `ctl` |
| `relay-lane` | `n` | "I opened relay lane `n`; join it." |
| `relay-gone` | `n` | Relay lane `n` closed |
