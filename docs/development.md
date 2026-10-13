# Development

## Layout

| Path | |
| --- | --- |
| [src/](../src/) | The signaling server (Rust, axum) |
| [web/](../web/) | The page: HTML, CSS and JavaScript modules, served as-is |
| [worker/](../worker/) | The relay, a Cloudflare Worker |
| [charts/uploadmyshit/](../charts/uploadmyshit/) | The Helm chart |
| [tests/signaling.rs](../tests/signaling.rs) | The server over real WebSockets |
| [tests/web/](../tests/web/) | The page's pure modules, under Node's test runner |
| [tests/e2e/](../tests/e2e/) | Two real Chrome processes, the server and a local relay |
| [scripts/](../scripts/) | Chart checks and packaging |

## Running it

```sh
cargo run
```

Open `http://localhost:8080` in two windows, or two Chrome profiles to keep their storage
apart. A debug build reads `web/` from disk at every request, so a page edit needs a
reload, not a rebuild. A release build embeds `web/` in the binary.

For the relay, run the Worker locally and point the server at it:

```sh
(cd worker && npm ci && npm run dev)          # ws://127.0.0.1:8787
UMS_RELAY_URL=ws://127.0.0.1:8787 cargo run
```

The page has no build step and no dependencies, and that is deliberate: what is in `web/`
is what runs.

## Tests

```sh
# The server: unit tests, and integration tests over real WebSockets
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test

# The page's pure modules: names and clutter, formatting, relay encryption
node --test 'tests/web/*.test.mjs'

# The chart: lint, and render checks of valid and invalid values (needs helm)
scripts/check-chart.sh
```

### End to end

```sh
cargo build
(cd worker && npm ci)            # optional: enables the relay scenarios
cd tests/e2e && npm ci
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node transfer.mjs
```

It starts the server and, with the Worker's dependencies installed, a local relay under
`wrangler dev`. It then drives two headless Chrome processes through:

- network rooms, and private rooms joined by link;
- a folder tree streamed into a chosen folder, byte for byte. That's 256 MB by default,
  in several connection modes.
- receiving without folder access, and the receiver stopping a transfer;
- names a folder refuses, cleaned on arrival. Also 2000 random hostile names run through
  the cleaner, each judged by Chrome itself in a real folder.
- a real folder dropped from disk, with clutter from every OS: left out, bytes intact,
  every name one Chrome writes;
- stale signals from a closed connection, which must not revive it;
- relay fallback with no direct path, "always use the relay", relay lanes beside a direct
  connection, and a relay lane that swallows data;
- a connection that lands on TURN handing over to the relay, which needs real TURN
  credentials;
- a tab left open across a deploy reloading itself once.

| Environment | |
| --- | --- |
| `CHROME_PATH` | The Chrome to drive. Unset: Playwright's own Chromium, as in CI. |
| `UMS_BIN` | The server binary (default `target/debug/uploadmyshit`) |
| `UMS_E2E_MB` | Size of the large file, in MB (default 256). Below about 64, the extra-connection and stop scenarios finish too fast to test what they test. |
| `UMS_E2E_THROTTLE` | Slow both pages' CPUs by this factor, to find races slower CI runners would find |
| `UMS_CLOUDFLARE_TURN_KEY_ID`, `UMS_CLOUDFLARE_TURN_API_TOKEN` | Enables the TURN-handoff scenario, against Cloudflare's TURN service |

Everything runs headless, so nothing pops up on your screen.

### Against real services

```sh
# Relay throughput through a deployed Worker (or `npm run dev` in worker/)
cd tests/e2e && RELAY_URL=wss://<your-worker>.<your-subdomain>.workers.dev node relay-bench.mjs

# Cloudflare's TURN API
UMS_CLOUDFLARE_TURN_KEY_ID=... UMS_CLOUDFLARE_TURN_API_TOKEN=... cargo test -- --ignored
```

The relay bench also reads:
- `RELAY_SECRET`, when the Worker requires tickets;
- `SECONDS`, for how long each setup streams;
- `ROUNDS`, for how many times each setup runs.

## Measuring Chrome's name rules

The name cleaning in [files.js](../web/js/files.js) follows what Chrome's File System Access
API accepts in a real folder. Chrome refuses some names there that its private storage
(OPFS) accepts. The rules come from measuring, not from reading specifications, and any
change to them should too.

You can ask Chrome directly, headless, without a permission prompt:

1. Drop a real, empty folder onto a page with CDP's `Input.dispatchDragEvent`, with
   `data.files: ["/path/to/folder"]`. Use the real path, not a symlink: on macOS,
   `/private/tmp` and not `/tmp`. The page must accept `dragover`.
   `e.dataTransfer.items[0].getAsFileSystemHandle()` then gives a real
   `FileSystemDirectoryHandle`, with read access.
2. Call `getFileHandle(name)` and `getDirectoryHandle(name)` without `create`.
   - A **`TypeError` ("Name is not allowed")** means Chrome refuses the name.
   - A **`NotFoundError`** means it would accept it.

   The name check runs before any permission check, so read access is enough.

The end-to-end suite's `chromeRefuses` helper does exactly this, and its name steps use
it. When adding a rule, add the names that prompted it to those steps, then break the rule
once to see the steps fail.

## Conventions

- **A test must be able to fail.** When adding one, break the code it covers once and
  watch it fail.
- **Measure before fixing.** Reproduce a reported failure, against a deployed instance or
  headless Chrome, before changing code.
- **Comments say why.** What the code does should be readable from the code. Match the
  surrounding comment density and naming.
- **No identifiers in the repository.** It is mirrored publicly. Keep account ids, Worker
  names, your own hostnames and internal addresses out of commits; use placeholders like
  `drop.example.com` and `<your-worker>`.

## CI

[.gitlab-ci.yml](../.gitlab-ci.yml) runs the same checks on every commit: Rust, the page's
unit tests, the end-to-end suite in Playwright's image with a local relay, and the chart.
It then builds the image, publishes the chart and, on `main`, deploys it. See
[deployment.md](deployment.md#cicd).
