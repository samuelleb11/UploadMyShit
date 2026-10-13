# The relay Worker

A Cloudflare Worker that carries data between two devices when WebRTC can't connect them
directly. It also lets large transfers add lanes beside a direct connection when that's
faster. You deploy it to your own Cloudflare account. The signaling server only signs
tickets for it.

The Worker never sees what it carries. The two pages encrypt everything end to end
(AES-256-GCM, with a key agreed by ECDH between them), and the Worker passes frames along
without looking inside.

## How it works

- Each device opens a WebSocket to `/v1/<session>/<a|b>[/<lane>]`.
- Both sides of one session and lane meet in a **Durable Object**, which passes every
  frame from one to the other. Once both are connected, each gets `{"t":"paired"}`.
- **One object per session and lane.** An object is single-threaded, so a transfer that
  opens several lanes spreads them over several objects. The Worker accepts lanes 0–7;
  the page uses up to 4.
- **The WebSocket Hibernation API.** An idle relay session isn't held in memory.
- **A relay is for two.**
  - When one side leaves, the other is closed.
  - A frame that arrives while the other side is gone closes the lane, rather than being
    swallowed, so the sender notices at once.
  - A device that reconnects replaces its earlier socket.

| Path | |
| --- | --- |
| `/`, `/health` | `uploadmyshit relay` |
| `/v1/<session>/<a\|b>[/<lane>]?exp=&sig=` | The relay. `426` without a WebSocket upgrade, `403` with a bad or expired ticket. |

## Tickets

With the `RELAY_SECRET` secret set, the Worker accepts a connection only with a ticket the
signaling server signed:
- `exp`: unix seconds;
- `sig`: base64url HMAC-SHA256 of `<session>.<exp>`, keyed with the secret.

The server gives one to each of the two devices in a room that asked to relay with each
other.

**Without `RELAY_SECRET`, anyone who knows the Worker's address can relay through it.**
Set it.

## Deploy

The first deploy needs `wrangler`, because the dashboard can't create a Durable Object
class. Name the Worker on the command line: the repository holds only a placeholder name,
so no account's Worker name lands in it.

```sh
cd worker
npm ci
npx wrangler login
npm run deploy -- --name <your-worker>
# the secret relay tickets are signed with: any long random string
npx wrangler secret put RELAY_SECRET --name <your-worker>
```

Then give the signaling server the same two things:

```sh
UMS_RELAY_URL=wss://<your-worker>.<your-subdomain>.workers.dev
UMS_RELAY_SECRET=<the same secret>
```

In the Helm chart, use `relay.url` and `relay.secret` (or `relay.existingSecret`). Check
it with `curl https://<your-worker>.<your-subdomain>.workers.dev/health`.

Redeploy after changing `relay.js` the same way: `npm run deploy -- --name <your-worker>`.
The Durable Object's storage class is declared in `wrangler.jsonc`'s migrations. Keep
existing migrations as they are and add new ones after them.

## Run it locally

```sh
npm ci
npm run dev       # ws://127.0.0.1:8787, no ticket checks unless RELAY_SECRET is set
```

Point a local server at it with `UMS_RELAY_URL=ws://127.0.0.1:8787`. The end-to-end tests
start it this way by themselves when `worker/node_modules` exists. To measure
throughput through it, or through a deployed Worker, use `tests/e2e/relay-bench.mjs`.

## Cost and limits

The Worker's traffic counts against your Cloudflare plan's Workers and Durable Objects
usage. It's used only in two cases:
- by pairs that can't connect directly;
- by large transfers it speeds up. Each person can turn that off in the page's Settings.

Without a relay, devices that can't connect directly need TURN, or can't connect at all.
