# Security

What each party can see and do, what protects it, and the gap that remains.

## Who sees what

| Party | Sees | Never sees |
| --- | --- | --- |
| The signaling server | Devices' names and kinds, rooms, connection setup (SDP, ICE candidates with IP addresses), relay public keys, when devices connect to each other | File names, sizes or contents |
| The relay Worker (your Cloudflare account) | Ciphertext, its size and timing, the two devices' IP addresses | File names, sizes or contents |
| A TURN provider | DTLS-encrypted WebRTC traffic, its size and timing | File names, sizes or contents |
| Other devices in the same room | Your device's name and kind; whatever you choose to send them | Anything else |
| Other websites | Nothing: the signaling WebSocket refuses other origins | |

## Transfers

- **Consent.** The receiver sees the sender's name, the files and the total size, and
  must accept each transfer. Nothing is written before that.
- **Paths can't escape the chosen folder.**
  - Every incoming path is cleaned before use: no `..`, no absolute paths, no characters a
    filesystem refuses, no Windows device names.
  - No bidirectional-text or invisible formatting characters, so a name can't disguise its
    extension.
  - Nothing already in the folder is overwritten: a clash becomes `name (2)`. See
    [architecture.md](architecture.md#names-and-os-clutter).
- **Integrity.**
  - WebRTC data channels are reliable and DTLS-authenticated.
  - Relay frames are AES-GCM-authenticated.
  - Every chunk is tracked by index, and the receiver only reports done once every byte
    of every file is written.

## The relay

- **End-to-end encryption.**
  - Each relay session uses a fresh ECDH P-256 key pair per device. An AES-256-GCM key is
    derived from the pair with HKDF-SHA256, salted with the session id.
  - Each frame's nonce carries the sending side, the lane and a counter. The receiver
    refuses a frame whose counter doesn't move forward, or that was meant for another
    lane, so the relay can't replay, reorder or redirect frames undetected.
  - [protocol.md](protocol.md#encryption) has the exact construction.
- **Tickets.**
  - A device can only open a relay session the server signed for it and one other device
    in its room: HMAC-SHA256 over the session id and expiry, checked by the Worker.
  - Without `RELAY_SECRET`, the Worker relays for anyone who knows its address, so set
    one.
- **One relay is for two.** When either side leaves, the Worker closes the other. A frame
  sent while the other side is gone closes the lane, rather than being swallowed.

## The server and the page

- **Strict Content-Security-Policy.** The page loads nothing from other sites. Its only
  outside connections are the configured STUN/TURN servers (WebRTC) and the relay Worker,
  whose origin the server adds to `connect-src`.
- **Same-origin signaling.** The WebSocket refuses other origins, so another site can't
  list the devices on a visitor's network or talk to them.
- **Identity per tab.** A device's id is derived from a random secret its tab holds. A
  reconnect keeps the id, and nobody else can claim it.
- **Limits.**
  - Each connection has a message-rate token bucket; repeated overruns disconnect it.
  - Connections are capped in total and per address, and so are devices per room.
  - Frames have a maximum size.
  - Device names, kinds and page versions are validated before they are passed on.
- **No storage.** Rooms live in memory. Nothing is written to disk or logged about
  transfers.

## Network rooms

A network room shows a device to everyone behind the same public address. The server
attributes that address with care:
- It believes a client-address header only from configured proxies.
- It takes the right-most untrusted entry, so a visitor can't pick their own room.
- Behind Cloudflare, it refuses to form a room when Cloudflare's own header disagrees with
  the address it worked out. This is the sign that a proxy is hiding every visitor
  behind one address, which would put strangers together.

Two limits remain, both inherent to grouping by public address:
- **Shared addresses.** Customers behind the same carrier-grade NAT, or the same VPN exit,
  share a room and see each other's device names.
- **Anyone with a private room's link can join it.** Codes are random (about 49 bits),
  but a link is a bearer token: share it like one.

To expose devices only by link, set `UMS_NETWORK_ROOMS=false`.

## The known gap

The server relays the WebRTC setup and the relay's key exchange. A compromised server
could therefore put itself in the middle of a new connection: answer each side with its
own keys and pass the data through. It can't do that silently to a connection already
running.

The fix is a short code derived from both ends' DTLS fingerprints and relay keys, which
the two people compare. It is on the roadmap.

## Diagnostics reports

Settings → Diagnostics → Copy report includes IP addresses (ICE candidates). That is what
makes it useful for debugging. Mind where you paste it.

## Reporting a vulnerability

Please report security issues privately to the maintainer rather than in a public issue.
