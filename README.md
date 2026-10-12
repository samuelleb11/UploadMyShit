# UploadMyShit

Send files and whole folders from one browser to another, peer to peer. It's a ShareDrop
replacement that streams straight to disk and moves large files at the fastest rate
Chrome's WebRTC allows.

- **Peer to peer.** File bytes go browser to browser over WebRTC data channels. The server
  only introduces devices and relays their connection setup, a few KB per transfer. It
  never sees a byte of the files.
- **Drag and drop, many files and folders at once.** Drop any mix of files and folders on
  a device, or click it to pick some. Folder structure is kept, empty folders included.
- **Streams straight to disk (Chrome).** The receiver picks a destination folder once and
  Chrome remembers it. Files and folders are written in place as they arrive, and each
  file appears, complete, the moment its last byte lands. Nothing waits for the whole
  batch and nothing is held in memory. Existing files are never overwritten: a clash
  becomes `name (2)`.
- **Automatic parallelism and flow control.** Disk reads run ahead in parallel. Writes
  happen in a Web Worker and merge into large sequential writes. Extra WebRTC connections
  open while they raise throughput, and stop once one fails to add 10%. The receiver
  grants a credit window, so a slow disk throttles the sender instead of filling memory.
  An optional upload cap applies across all transfers.
- **Works across networks.** Devices behind the same public address see each other
  automatically. A private room (a link or a QR code) connects devices anywhere.
- **A relay for when direct fails, and for speed.** When two devices can't connect
  directly, they relay through a small Cloudflare Worker you deploy (`worker/`). The data
  is end-to-end encrypted, so the Worker passes bytes it cannot read. Large transfers also
  add relay lanes beside a direct connection when that turns out faster. TURN remains an
  option.
- **Diagnostics built in.** Settings → Diagnostics shows how each connection travels
  (route, candidates, round trip, lanes and their rates) and runs a network test. It also
  explains why a direct connection would or wouldn't work from here.

## How it works

```
 Browser A ──── WebSocket (signaling: who's here, SDP, ICE, relay tickets) ───┐
     │                                                                        ▼
     │                                                  uploadmyshit (Rust, axum)
     │                                                  rooms in memory, no storage
 Browser B ──── WebSocket ────────────────────────────────────────────────────┘
     ▲
     ├──── WebRTC data channels, DTLS-encrypted, direct ──────────── Browser A
     │
     └──── WebSockets ── relay Worker (Cloudflare) ── WebSockets ─── Browser A
           end-to-end encrypted; when there is no direct path, or beside one when faster
```

- **Server** ([src/](src/)): serves the page, which is compiled into the binary, and one
  WebSocket at `/ws`.
  - **Rooms.** A *network room* holds everyone behind one public IPv4 address or IPv6
    /64. A *private room* is named by a code in the URL (`/r/<code>`). A device can only
    signal devices in its own room.
  - **ICE servers.** The server hands out STUN servers and TURN credentials. It mints the
    credentials (coturn shared-secret scheme) or fetches them (Cloudflare).
  - **Relay tickets.** When a device asks to relay with another in its room, the server
    names a fresh session and signs a ticket for each side. The Worker checks it.
  - **Health.** `/healthz` and `/readyz`.
- **Page** ([web/](web/)): hand-written HTML, CSS and JavaScript modules. No build step,
  no dependencies.
  - [peer.js](web/js/peer.js): the connections to one device. The first WebRTC
    connection is negotiated through the server; extra ones are negotiated over the first,
    browser to browser. It also manages the relay: falling back to it, and adding lanes
    through it.
  - [relay.js](web/js/relay.js): relay lanes and their end-to-end encryption.
  - [transfer.js](web/js/transfer.js): the transfer protocol (chunking, lanes, credit
    window, resend, adaptive scaling).
  - [sink-worker.js](web/js/sink-worker.js): disk writes.
  - [app.js](web/js/app.js) and [diagnostics.js](web/js/diagnostics.js): the UI.
- **Relay** ([worker/](worker/)): a Cloudflare Worker with one Durable Object per relay
  session and lane. It pairs two WebSockets and passes frames between them. It hibernates
  when idle.

Integrity: data channels are reliable and DTLS-authenticated. On top of that, every chunk
is tracked by index. If a connection dies mid-transfer, the receiver asks again for
exactly what it is missing.

## Browsers

**Chrome on a computer is the supported browser.** It has the File System Access API that
lets the receiver stream into a folder. Every browser with WebRTC can *send*.

Browsers without folder access can still *receive*: Chrome on Android, anything on iOS,
Firefox and Safari. Each file downloads on its own as soon as it is complete. Folder
structure is lost there, because a download is a single file.

## Performance

Chrome's data channels are the ceiling, not this code. Each ~1.2 KB packet crosses from
the page's process to Chrome's network process separately. Chromium has a batched path
but it is switched off. No published Chrome browser-to-browser measurement exceeds about
45 MB/s.

Measured with two separate Chrome processes on one Apple Silicon Mac, streaming into a
folder:

| Setup | Throughput |
| --- | --- |
| Raw data channel, 1 connection (no app) | 37 MB/s (296 Mbps) |
| This app, 1 connection | 31–45 MB/s (248–360 Mbps) |
| This app, 4 connections | 36–42 MB/s (288–336 Mbps) |

Two machines each give their side a full CPU, so real LAN transfers should do at least
this well.

The relay Worker doesn't have that ceiling: it is plain WebSockets over TCP. Two browsers
on one machine relaying through a deployed Worker in a nearby Cloudflare location
measured 0.8–1.05 Gbps on one lane and about 2.2 Gbps on three, consistently. That is a
best case. Real devices are limited by their own upload and download speed, and by their
distance to the Worker's location. For comparison, Cloudflare's TURN service varied
between 0.6 and 85 Mbps from one connection to the next.

## Running it locally

```sh
cargo run
# open http://localhost:8080 in two browser windows (or two devices on your LAN)
```

A debug build serves `web/` from disk, so edits to the page only need a reload. A release
build (`cargo build --release`) embeds it.

Browsers give WebRTC and folder access only to secure pages. `localhost` counts as
secure; a LAN address over plain HTTP does not. Use TLS (the Helm chart's ingress does)
to try it across devices.

## Configuration

Every flag has an environment variable. Run `uploadmyshit --help` for the full list.

| Variable | Default | |
| --- | --- | --- |
| `UMS_BIND` | `0.0.0.0:8080` | Listen address |
| `UMS_NETWORK_ROOMS` | `true` | Automatic rooms by public address. `false`: private rooms only |
| `UMS_CLIENT_IP_HEADER` | – | e.g. `x-forwarded-for`, or `cf-connecting-ip` behind Cloudflare (proxied or a Tunnel); read only from `UMS_TRUSTED_PROXIES` |
| `UMS_TRUSTED_PROXIES` | – | CIDRs of the proxies in front, comma-separated |
| `UMS_IPV4_PREFIX` / `UMS_IPV6_PREFIX` | `32` / `64` | What makes up one network room |
| `UMS_MAX_ROOM_PEERS` | `50` | |
| `UMS_MAX_CONNECTIONS` / `UMS_MAX_CONNECTIONS_PER_IP` | `10000` / `64` | |
| `UMS_STUN_URLS` | Cloudflare + Google STUN | Comma-separated; empty for none |
| `UMS_TURN_URLS` | – | External `turn:`/`turns:` URLs |
| `UMS_TURN_USERNAME`, `UMS_TURN_CREDENTIAL` | – | Static TURN credentials |
| `UMS_TURN_SECRET` | – | coturn `use-auth-secret`: per-device, time-limited credentials |
| `UMS_TURN_TTL` | `86400` | Lifetime of generated credentials; make it longer than any transfer |
| `UMS_CLOUDFLARE_TURN_KEY_ID`, `UMS_CLOUDFLARE_TURN_API_TOKEN` | – | Cloudflare Realtime TURN |
| `UMS_RELAY_URL` | – | The relay Worker, `wss://…`. Unset: no relay |
| `UMS_RELAY_SECRET` | – | The Worker's `RELAY_SECRET`, used to sign relay tickets |
| `UMS_RELAY_TTL` | `21600` | How long a relay ticket opens connections, in seconds |
| `UMS_SHUTDOWN_DELAY` | `5` | Seconds of failing readiness before connections close on SIGTERM |
| `UMS_LOG`, `UMS_LOG_FORMAT` | `info`, `text` | Log filter; `json` for structured logs |

### The relay, and TURN

Most pairs of devices connect directly; STUN is enough for that. STUN is also how a
browser discovers its public address for hole punching, so keep it whatever else you
use. A pair whose networks allow no direct path needs a relay. This happens with
symmetric NATs on some corporate and mobile networks.

**The relay Worker** is the recommended fallback (see [Deploying the relay](#the-relay-worker)).
- **Fallback:** if no direct connection opens within about 4 seconds, the page switches
  to it.
- **Boost:** during a large transfer, if its lanes are the bottleneck, the page adds relay
  lanes and keeps them only if the rate rises by at least 10%. Users can turn this off in
  Settings.

**TURN** remains supported, through any of these, alongside the relay or instead of it.
WebRTC uses it inside the connection, when no direct candidate pair works.

- **Cloudflare Realtime TURN:** set the key id and API token. The server fetches
  short-lived ICE servers from Cloudflare, caches them for half their lifetime and hands
  them out. Cloudflare's port-53 URLs are filtered out because browsers block that port.
- **coturn**, or any TURN server that supports the REST shared-secret scheme: set
  `UMS_TURN_URLS` and `UMS_TURN_SECRET`. Each device gets its own credentials, which
  expire.
- **Static credentials:** set `UMS_TURN_URLS`, `UMS_TURN_USERNAME` and
  `UMS_TURN_CREDENTIAL`.

Extra WebRTC connections are never opened over TURN.

## Deploying

### Docker

```sh
docker build -t uploadmyshit .
docker run -p 8080:8080 -e UMS_CLOUDFLARE_TURN_KEY_ID=... -e UMS_CLOUDFLARE_TURN_API_TOKEN=... uploadmyshit
```

The image is distroless, runs as non-root and writes nothing.

### The relay Worker

The relay is a Cloudflare Worker with a Durable Object, and the first deploy needs
`wrangler`: the Cloudflare dashboard can't create a Durable Object class. Name the
Worker on the command line. The repository holds only a placeholder name.

```sh
cd worker
npm ci
npx wrangler login
npm run deploy -- --name <your-worker>
# the secret that relay tickets are signed with: any long random string
npx wrangler secret put RELAY_SECRET --name <your-worker>
```

Then give the server the Worker's address and the same secret: `UMS_RELAY_URL=wss://<your-worker>.<your-subdomain>.workers.dev`
and `UMS_RELAY_SECRET`, or `relay.url` and `relay.secret`/`relay.existingSecret` in the
chart. The server adds the Worker's origin to the page's Content-Security-Policy.

Without `RELAY_SECRET`, the Worker relays for anyone who knows its address. Set it.

### Kubernetes (Helm)

The chart is in [charts/uploadmyshit](charts/uploadmyshit). CI publishes it to this
project's Helm registry: the `stable` channel from `main`, `dev` from `dev`. It runs
**one replica**, because rooms live in memory. That is plenty: the server carries
signaling only.

An example values file, which is what CI's `UPLOADMYSHIT_VALUES` file variable holds:

```yaml
imagePullSecrets:
  - name: gitlab-registry
ingress:
  enabled: true
  className: nginx
  host: drop.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
relay:
  url: wss://<your-worker>.<your-subdomain>.workers.dev
  existingSecret: uploadmyshit-relay    # key: relay-secret (the Worker's RELAY_SECRET)
```

```sh
kubectl -n production create secret generic uploadmyshit-relay \
  --from-literal=relay-secret=...
```

TURN is configured the same way under `ice.turn` or `ice.cloudflare`; see
[values.yaml](charts/uploadmyshit/values.yaml).

**Network rooms need real client addresses.** The server reads `X-Forwarded-For` from the
proxies in `server.trustedProxies` (private ranges by default). The ingress controller
must see visitors' real addresses itself. For ingress-nginx, that means its Service uses
`externalTrafficPolicy: Local`, or the load balancer sends the PROXY protocol.

If every visitor arrives as one address, everyone lands in one room. To check, open the
page from two different networks: they must not see each other. If they do, fix the
client addresses or set `server.networkRooms=false`.

### CI/CD

The project lives on a GitLab instance; [GitHub](https://github.com/samuelleb11/UploadMyShit)
carries a mirror of `main`. [.gitlab-ci.yml](.gitlab-ci.yml) follows
[agent-router](https://github.com/samuelleb11/agent-router)'s pipeline:
- **Checks:** Rust fmt, clippy and tests; the page's unit tests; the two-browser
  end-to-end test; the chart checks.
- **Release:** an image per commit, `latest` on `main`, the chart published per commit,
  and `helm upgrade` to production on `main` at the commit's own image tag.

Set these CI/CD variables: `CI_TEMPLATES_PROJECT`, `DEPLOY_TOKEN_USER`/`DEPLOY_TOKEN`,
`UPLOADMYSHIT_VALUES` (a file variable) and, optionally, `KUBE_CONTEXT`.

The image jobs come from a shared template project (`CI_TEMPLATES_PROJECT`) that is not
part of this repository. Elsewhere, replace them with your own `docker build` and push;
every other job runs on a public image and is defined in full here.

## Development

```sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
node --test 'tests/web/*.test.mjs'

# Two real Chrome processes sending files to each other through the server. With the
# Worker's dependencies installed, the relay scenarios run too, against a local relay:
cargo build && (cd worker && npm ci) && cd tests/e2e && npm ci
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node transfer.mjs

# Relay throughput, through a deployed Worker or a local `npm run dev` in worker/:
RELAY_URL=wss://<your-worker>.<your-subdomain>.workers.dev node relay-bench.mjs

# Against the real Cloudflare API, with a key in the environment:
UMS_CLOUDFLARE_TURN_KEY_ID=... UMS_CLOUDFLARE_TURN_API_TOKEN=... cargo test -- --ignored

# The chart (needs helm):
scripts/check-chart.sh
```

## Security notes

- **Transfers need consent.** The receiver sees the sender, the file list and the total
  size, and must accept each transfer.
- **Incoming paths are sanitised.** No `..`, no absolute paths, no characters a
  filesystem rejects, no Windows device names, no bidirectional-text tricks. Nothing is
  written outside the chosen folder, and nothing there is overwritten.
- **The page is locked down.** It loads nothing from anywhere else (strict CSP). The
  WebSocket refuses other origins, so another site can't list the devices on your
  network.
- **Identity is per tab.** A device's id is derived from a secret held by its tab; a
  reconnect keeps it, and nobody else can claim it.
- **The server is limited.** It rate-limits signaling messages and caps connections per
  address, devices per room and frame size.
- **The relay passes ciphertext only.** Each relay session's AES-256-GCM key comes from
  an ECDH P-256 exchange between the two pages. Frames carry a counter, so the receiver
  refuses replayed or reordered frames. The Worker accepts only connections with a ticket
  signed by the server.
- **The server can see that devices connected, never what they sent.** It does relay the
  WebRTC setup and the relay's key exchange, so a compromised server could in principle
  insert itself. Comparing a code derived from both ends' keys out of band would close
  that gap; it is on the roadmap.
- **The diagnostics report contains IP addresses.** That is what makes it useful; mind
  where you paste it.

## Roadmap

- Resume an interrupted transfer, using the per-chunk tracking that already exists.
- Move receiving into a Worker with transferable `RTCDataChannel` (Chrome 130+).
- A short verification code from both ends' keys (DTLS and relay), to detect a man in
  the middle.
- Several replicas, with rooms in a shared store.

## License

MIT — see [LICENSE](LICENSE).
