# Architecture

UploadMyShit has three parts:

- **The signaling server:** a Rust binary that introduces devices to each other.
- **The page:** plain JavaScript that does the connecting and moves the data.
- **An optional relay:** a Cloudflare Worker, for devices that can't connect directly.

File data never passes through the server.

```
 Browser A ──── WebSocket /ws ──── uploadmyshit ──── WebSocket /ws ──── Browser B
     │                                                                      │
     ├──────── WebRTC data channels (DTLS), direct or through TURN ─────────┤
     │                                                                      │
     └─── WebSocket ─── relay Worker (Durable Object) ─── WebSocket ────────┘
                         end-to-end encrypted frames
```

The wire formats are in [protocol.md](protocol.md).

## The server

[src/](../src/) is an [axum](https://github.com/tokio-rs/axum) application. It has no
database and writes nothing to disk.

| Path | |
| --- | --- |
| `/` and `/r/<code>` | The page. `/r/<code>` opens a private room. |
| `/v/<version>/…` | The page's scripts and styles. See [Updates](#updates-and-versions). |
| `/ws` | Signaling, one WebSocket per tab. |
| `/api/qr?d=<text>` | A room link as an SVG QR code, so a phone can join with its camera. |
| `/healthz` | Liveness: `{"status":"ok","version":…,"stats":…}`. |
| `/readyz` | Readiness: fails from the moment shutdown starts. |

### Rooms

A device can only see, and signal, devices in its own room.

- **Network room.** All devices behind one public IPv4 address (`/32`) or one IPv6 `/64`
  share a room, as in ShareDrop. The prefix lengths are configurable.
- **Private room.** A code in the URL (`/r/<code>`, 4 to 64 of `a-z 0-9 - _`). The page
  generates 10-character codes, about 49 bits. Anyone with the link can join.
- **No room.** With network rooms turned off, a device without a code is alone until it
  joins a private room.
- **Address unknown.** When the server can tell it doesn't know a visitor's real address,
  it puts that visitor in no network room rather than in one with strangers. See
  [below](#the-visitors-address).

Rooms live in memory, which is why the server runs as one replica. A restart empties
them, and pages reconnect and re-announce themselves within seconds.

### The visitor's address

Network rooms are only as good as the address the server attributes to each visitor. By
default that is the TCP peer. Behind a reverse proxy, the server reads a header
(`--client-ip-header`), but only when the TCP peer is one of `--trusted-proxies`. From a
header like `X-Forwarded-For`, it takes the right-most address that isn't a trusted proxy:
every proxy appends what it saw, so the entries further left are whatever the visitor
chose to send.

Cloudflare adds `CF-Connecting-IP` to every request it passes on, whether through proxied
DNS or a Cloudflare Tunnel, and proxies after it leave that header alone. If it is present
and disagrees with the address the server worked out, then that address belongs to a
proxy in between. This happens, for example, when an ingress controller rewrites
`X-Forwarded-For` to the tunnel's own pod address. Every visitor would then share that
address, and one network room would become a public lobby. So the visitor gets the
`address-unknown` room kind instead, and the server logs once what to set:
`--client-ip-header=cf-connecting-ip`.

### What else it does

- **Passes signals.** SDP, ICE candidates and the relay's key exchange go from one device
  to another in the same room, unread.
- **Hands out ICE servers.** It gives out STUN URLs, and TURN credentials in one of three
  ways:
  - static credentials;
  - per-device, time-limited credentials (coturn's shared-secret scheme);
  - short-lived credentials fetched from Cloudflare Realtime TURN, cached for half their
    lifetime. Cloudflare's port-53 URLs are dropped, because browsers block that port.

  Pages ask for fresh credentials before old ones expire.
- **Signs relay tickets.** When a device asks to relay with another, the server picks a
  random session id and sends each side a ticket for it. The ticket is
  HMAC-SHA256(`<session>.<exp>`), checked by the Worker.
- **Limits.** Each connection has a message-rate token bucket (a burst of 200, 50 per
  second); repeated overruns close it. The server also caps:
  - connections in total and per address;
  - devices per room;
  - frame size.
- **Shuts down gently.** On SIGTERM, readiness fails first. After `--shutdown-delay`,
  every connection is closed with `bye: restart`, and pages reconnect to the new instance.
  Transfers already running are browser to browser and don't notice.

## The page

[web/](../web/) is served as-is: no bundler, no framework, no dependencies.

| Module | |
| --- | --- |
| [app.js](../web/js/app.js) | The UI: devices, rooms, dialogs, transfer cards, settings |
| [signaling.js](../web/js/signaling.js) | The WebSocket to the server, with reconnects and keep-alive |
| [peer.js](../web/js/peer.js) | Everything about one other device: its connections, relay lanes and transfers |
| [relay.js](../web/js/relay.js) | Relay lanes and their end-to-end encryption |
| [transfer.js](../web/js/transfer.js) | The transfer protocol, both directions |
| [files.js](../web/js/files.js) | Collecting what was dropped or picked; OS clutter; safe names |
| [sink.js](../web/js/sink.js), [sink-worker.js](../web/js/sink-worker.js) | Where received files go, and the worker that writes them |
| [diagnostics.js](../web/js/diagnostics.js) | Settings → Diagnostics and its network test |

### Connecting to a device

The first WebRTC connection is negotiated through the server with "perfect negotiation":
either side may start, and a collision resolves itself. Both of its data channels are
pre-negotiated with fixed ids on both sides:
- `ctl` (id 0): control messages;
- `data` (id 1): file bytes.

Extra connections for speed are negotiated over `ctl`, browser to browser, without the
server.

Every signal carries both sides' connection ids. A signal left over from a connection
that has since closed is recognised and dropped, so it can never revive the old one.

Every 2 seconds the page also works out which path the connection took: `lan` (both ends
on host candidates), `direct` (through NAT), or `turn`.

### When there is no direct path

1. **Relay fallback.** If no direct connection opens within 4 seconds and a relay is
   configured, the page asks for a relay session. Only the "polite" side of the pair asks
   the server; the other side asks it to through signaling, so two requests never cross.
   Both sides then exchange ECDH public keys through signaling and open an encrypted lane.
2. **TURN handoff.** If WebRTC connects but lands on TURN, there is no direct path. The
   relay is faster and costs nothing per byte, so it takes over data and control at once.
   TURN stays connected as a backup.
3. **TURN only.** Without a relay, a connection that needs TURN uses it for everything.

### A transfer

1. The sender **offers** the file list. The receiver sees who is sending, what, and how
   much, and **accepts** or declines.
2. The accept names a **credit window**: 64 MB, or 32 MB on devices reporting 4 GB of
   memory or less. The sender never has more than that in flight or waiting for the
   receiver's disk.
3. The sender **reads ahead** from disk, about 4 MB per read with up to 6 reads at once,
   staying at most 32 MB ahead of what has been sent.
4. **Chunks** are up to 256 KB, in multiples of 4 KB. Files go in order, and every lane
   takes the next chunk, so files finish one after another and each is usable the moment
   it completes.
5. **Lanes** are WebRTC data channels and relay WebSockets, and the transfer code treats
   them alike. The sender keeps each lane's queue about as deep as that lane drains in
   under a second, measured as it goes, and never deeper than 8 MB.
6. The receiver **acks** every 100 ms, with how much arrived on each lane and how much
   was written. When a lane has sent everything in a pass, it sends a **FIN**. Once every
   lane has, the receiver either asks again for whatever is missing or says done.

**Scaling.** Every 2 seconds the sender checks what it has been waiting for. When its lanes
are the bottleneck, and not the window, the disk or the upload cap, it adds a connection.
It only does this while at least 64 MB remain. A new lane that doesn't raise the rate by
10% is closed again.

- **Automatic mode** goes up to 4 WebRTC connections. The setting allows up to 8.
- **Relay lanes** are added the same way, up to 4, when "Speed up transfers through the
  relay" is on.
- Extra WebRTC connections are never opened over TURN.

**Recovery:**
- A lane that holds unacknowledged data for 8 seconds while the receiver is otherwise
  answering is dead, even if it still looks open. A relay whose far end vanished swallows
  data this way. It is dropped, and what it held is sent again.
- A transfer with no progress at all for 45 seconds fails with "the other device stopped
  responding".

### Receiving

[sink-worker.js](../web/js/sink-worker.js) writes off the main thread, in one of three
modes:

- **`dir`**: a folder the user picked (Chrome's File System Access API).
  - Its handle is kept in IndexedDB, so later transfers stream into it without asking
    again. At most, Chrome asks to confirm access once per visit.
  - Every file is written in its final place inside its folders, and appears complete
    when its last byte lands.
  - Chunks arrive in any order, and each lands at its own offset. Chunks queued for one
    file are sorted and merged into larger writes.
- **`opfs`**: the browser's private storage, in browsers without folder access. Each
  completed file is handed to the page to save as a download.
- **`mem`**: memory, as a last resort. Otherwise it works like `opfs`.

Stopping a transfer removes whatever was only half written.

### Names and OS clutter

**The sender leaves out what operating systems put in folders by themselves**, and tells
the user what it left out:

| From | Left out |
| --- | --- |
| Windows | `Thumbs.db`, `ehthumbs.db`, `desktop.ini`, `$RECYCLE.BIN`, `System Volume Information` |
| macOS | `.DS_Store`, `._*` sidecars, `Icon\r`, `.Spotlight-V100`, `.Trashes`, `.fseventsd`, `__MACOSX` |
| Linux desktops | `.directory`, `.Trash-*` |
| Office suites | Lock files: `~$*`, `.~lock.*#` |

The full list is in [files.js](../web/js/files.js). Clutter folders aren't even opened.

**Every name is cleaned on both sides.** The sender cleans, so that a receiver still on an
older page never gets a name its Chrome refuses. The receiver cleans again, since it can't
trust the sender.

The rules are what Chrome's File System Access API accepts in a real folder, measured
against one on disk (see [development.md](development.md#measuring-chromes-name-rules)):
- A name may start with one dot (`.gitignore`).
- After that dot, and at either end of the name, there may be no space, dot or `~`. So
  `..a`, `.~a`, `~a`, `a~` and `a.` are refused, while `a~b` and `a..b` are fine.
- No control or invisible formatting characters anywhere. That includes soft hyphens,
  zero-width joiners (even inside emoji) and direction marks.
- No Unicode noncharacters, and none of `" * / : < > ? \ |`.
- No shortcut or CLSID extension: `.lnk`, `.scf`, `.url`, `.{…}`.
- No Windows reserved name: `con`, `com1`, `lpt1`, `clock$`, `desktop.ini` and so on,
  with or without an extension.

A character Chrome refuses becomes `_`, so different names stay different. Trailing dots
and spaces are dropped, as Windows would drop them. Each name is limited to 240 bytes,
keeping its extension, and a path to 64 levels. Cleaning a cleaned name changes nothing.
`..` and absolute paths can't escape the chosen folder.

## Updates and versions

The page's scripts and styles are served under `/v/<version>/`. The version is a hash of
everything in `web/`.
- Those URLs are cached for a year, as immutable.
- The page itself is `no-cache`.
- A request for another version gets `private, no-store`.

So a cache in front can never mix a new page with old scripts. Cloudflare, for example,
can rewrite `no-cache` to four hours.

The server's welcome message names the current version. A tab whose scripts came from
another version reloads itself once, as soon as no transfer is running. If transfers are
running, it says that an update is ready. Each page also reports its version to the
others in the room, and a device on an older page is marked **outdated, reload it**.
