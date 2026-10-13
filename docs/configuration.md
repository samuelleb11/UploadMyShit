# Configuration

Every setting is a command-line flag and an environment variable. `uploadmyshit --help`
prints the same list. The [Helm chart](../charts/uploadmyshit) sets them from its values.

## Server

| Flag | Environment | Default | |
| --- | --- | --- | --- |
| `--bind` | `UMS_BIND` | `0.0.0.0:8080` | Address and port to listen on |
| `--shutdown-delay` | `UMS_SHUTDOWN_DELAY` | `5` | Seconds of failing readiness, still serving, after SIGTERM, before every connection is closed |
| `--log-format` | `UMS_LOG_FORMAT` | `text` | `text` or `json` (the Docker image sets `json`) |
| | `UMS_LOG` | `info` | Log filter, e.g. `uploadmyshit=debug,info` |

## Rooms and visitor addresses

| Flag | Environment | Default | |
| --- | --- | --- | --- |
| `--network-rooms` | `UMS_NETWORK_ROOMS` | `true` | Put devices behind one public address in an automatic room. `false`: only private rooms. |
| `--ipv4-prefix` | `UMS_IPV4_PREFIX` | `32` | IPv4 prefix length of one network room (8–32) |
| `--ipv6-prefix` | `UMS_IPV6_PREFIX` | `64` | IPv6 prefix length of one network room (16–128); a home LAN is usually one /64 |
| `--client-ip-header` | `UMS_CLIENT_IP_HEADER` | – | Header with the visitor's address, read only from trusted proxies: `x-forwarded-for`, `x-real-ip`, or `cf-connecting-ip` behind Cloudflare. Unset: the TCP peer is the visitor. |
| `--trusted-proxies` | `UMS_TRUSTED_PROXIES` | – | Comma-separated CIDRs of the proxies in front. The visitor is the right-most address in the header that isn't one of them. |

See [Visitor addresses and network rooms](deployment.md#visitor-addresses-and-network-rooms).

## Limits

| Flag | Environment | Default | |
| --- | --- | --- | --- |
| `--max-room-peers` | `UMS_MAX_ROOM_PEERS` | `50` | Most devices in one room |
| `--max-connections` | `UMS_MAX_CONNECTIONS` | `10000` | Most signaling connections at once |
| `--max-connections-per-ip` | `UMS_MAX_CONNECTIONS_PER_IP` | `64` | Most signaling connections from one visitor address |

The message rate per connection (a burst of 200, then 50 per second) and the frame size
are fixed.

## ICE: STUN and TURN

| Flag | Environment | Default | |
| --- | --- | --- | --- |
| `--stun-urls` | `UMS_STUN_URLS` | `stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302` | STUN servers for browsers, comma-separated; empty for none |
| `--turn-urls` | `UMS_TURN_URLS` | – | External `turn:`/`turns:` URLs, comma-separated |
| `--turn-username` | `UMS_TURN_USERNAME` | – | Static TURN username |
| `--turn-credential` | `UMS_TURN_CREDENTIAL` | – | Static TURN password |
| `--turn-secret` | `UMS_TURN_SECRET` | – | Shared secret for per-device, time-limited credentials (TURN REST scheme; coturn's `use-auth-secret`) |
| `--turn-ttl` | `UMS_TURN_TTL` | `86400` | Lifetime of generated credentials, in seconds. Make it longer than the longest transfer. |
| `--cloudflare-turn-key-id` | `UMS_CLOUDFLARE_TURN_KEY_ID` | – | Cloudflare Realtime TURN key id |
| `--cloudflare-turn-api-token` | `UMS_CLOUDFLARE_TURN_API_TOKEN` | – | Cloudflare Realtime TURN API token |

## Relay

| Flag | Environment | Default | |
| --- | --- | --- | --- |
| `--relay-url` | `UMS_RELAY_URL` | – | The relay Worker, `wss://…`. Unset: no relay. |
| `--relay-secret` | `UMS_RELAY_SECRET` | – | The Worker's `RELAY_SECRET`, used to sign relay tickets |
| `--relay-ttl` | `UMS_RELAY_TTL` | `21600` | How long a ticket opens connections, in seconds. Open connections outlive it. |

## Checks at startup

The server refuses to start with a combination browsers would reject, or one that can't
work:

- TURN URLs without credentials, or credentials without TURN URLs.
- A TURN username without a credential, or the reverse.
- Static credentials and a shared secret together.
- A Cloudflare key id without its token, or the reverse.
- `--client-ip-header` without any `--trusted-proxies`.
- `--turn-ttl` below 600 seconds: credentials would expire mid-transfer.
- A relay URL that isn't `wss://` or `ws://`.
- A relay secret without a relay URL.
- `--relay-ttl` below 60 seconds.

The chart applies the same checks when it renders, so a bad install fails before
anything is deployed.

## In the page

Each person's own settings, kept in their browser, are under Settings:

| Setting | |
| --- | --- |
| This device's name | Shown to the other devices. A random name ("Calm Otter") until changed. |
| Save received files to | The folder received files stream into (Chrome on a computer) |
| Upload speed limit | MB/s across all outgoing transfers; 0 for none |
| Parallel connections per device | Automatic (up to 4, while each raises the rate), or a fixed 1, 2, 4 or 8 |
| Speed up transfers through the relay | Add relay lanes beside a direct connection when that's faster. On by default when a relay is configured. |

Settings → Diagnostics has two switches for testing, which apply to connections made
after you change them:
- "Always use the relay" skips direct connections.
- "WebRTC through TURN only" offers no direct candidates.
