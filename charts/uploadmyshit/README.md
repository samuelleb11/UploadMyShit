# UploadMyShit Helm chart

The signaling server for [UploadMyShit](https://github.com/samuelleb11/UploadMyShit):
browser-to-browser file and folder transfer over WebRTC. The server introduces devices to
each other. Files never pass through it.

The chart runs **one replica**, by design. Rooms live in the process's memory, so two
replicas would split every room in two. One is plenty, since the server only passes small
signaling messages. A rollout briefly overlaps the old pod and the new one. Pages
reconnect on their own, and transfers already running are browser to browser and don't
notice.

## Install

```sh
helm upgrade --install uploadmyshit charts/uploadmyshit \
  --namespace uploadmyshit --create-namespace \
  --values my-values.yaml
```

Rancher, and other tools that add a top-level `global:` block, work as they are: the
schema accepts it.

The chart refuses inconsistent values when it renders, before anything reaches the
cluster. After an install, its notes say what to check. `helm test` fetches `/healthz` and
the page through the Service.

## Examples

**ingress-nginx with cert-manager, and a relay Worker:**

```yaml
image:
  repository: registry.example.com/uploadmyshit
  tag: "<commit sha>"
ingress:
  enabled: true
  className: nginx
  host: drop.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
relay:
  url: wss://<your-worker>.<your-subdomain>.workers.dev
  existingSecret: uploadmyshit-relay   # key: relay-secret
```

**Behind a Cloudflare Tunnel, or Cloudflare's proxy.** Read visitors' addresses from
Cloudflare's header. An ingress controller after Cloudflare often rewrites
`X-Forwarded-For` to its own address, which would put every visitor in one network room.

```yaml
server:
  clientIpHeader: cf-connecting-ip
```

Also set Cloudflare's Browser Cache TTL to "Respect Existing Headers".

**TURN through Cloudflare Realtime**, from a Secret:

```yaml
ice:
  cloudflare:
    existingSecret: uploadmyshit-turn  # keys: key-id, api-token
```

## Values

### Image

| Value | Default | |
| --- | --- | --- |
| `image.repository` | `registry.example.com/uploadmyshit/uploadmyshit` | The image to run |
| `image.tag` | `""` | Empty: the chart's `appVersion`. Deploy a commit's own tag, so a rollback rolls back the binary. |
| `image.pullPolicy` | `IfNotPresent` | |
| `imagePullSecrets` | `[]` | |
| `nameOverride`, `fullnameOverride` | `""` | |

### Server

| Value | Default | |
| --- | --- | --- |
| `server.networkRooms` | `true` | Devices behind one public address see each other. `false`: only private rooms. |
| `server.ipv4Prefix` | `32` | IPv4 prefix length of one network room |
| `server.ipv6Prefix` | `64` | IPv6 prefix length of one network room |
| `server.maxRoomPeers` | `50` | Most devices per room |
| `server.maxConnections` | `10000` | Most signaling connections |
| `server.maxConnectionsPerIp` | `64` | Most signaling connections per visitor address |
| `server.clientIpHeader` | `x-forwarded-for` | Header with the visitor's address, read only from `trustedProxies`. Behind Cloudflare: `cf-connecting-ip`. |
| `server.trustedProxies` | private ranges, `100.64.0.0/10`, `fc00::/7` | Proxies whose header is believed |
| `server.shutdownDelaySeconds` | `5` | Failing readiness, still serving, after SIGTERM |
| `server.logFormat` | `json` | `json` or `text` |
| `server.logLevel` | `info` | Log filter, e.g. `uploadmyshit=debug,info` |
| `server.extraArgs` | `[]` | Extra server flags |
| `server.extraEnv` | `[]` | Extra environment variables |

**Network rooms need each visitor's real address.** The ingress controller must see it
itself. For ingress-nginx, that means its Service uses `externalTrafficPolicy: Local`, or
the load balancer sends the PROXY protocol. Check after installing: two devices on
different networks must not see each other.

### ICE servers

| Value | Default | |
| --- | --- | --- |
| `ice.stunUrls` | Cloudflare and Google STUN | STUN servers handed to browsers |
| `ice.turn.urls` | `[]` | `turn:`/`turns:` URLs of an external TURN server |
| `ice.turn.username`, `ice.turn.credential` | `""` | Static credentials |
| `ice.turn.secret` | `""` | coturn `use-auth-secret`: per-device, time-limited credentials |
| `ice.turn.ttlSeconds` | `86400` | Lifetime of generated credentials; longer than any transfer |
| `ice.turn.existingSecret` | `""` | A Secret with `turn-username`, `turn-credential` and/or `turn-secret` |
| `ice.cloudflare.keyId`, `ice.cloudflare.apiToken` | `""` | Cloudflare Realtime TURN |
| `ice.cloudflare.existingSecret` | `""` | A Secret with `key-id` and `api-token` |

### Relay

| Value | Default | |
| --- | --- | --- |
| `relay.url` | `""` | The relay Worker, `wss://<your-worker>.<your-subdomain>.workers.dev`. Empty: no relay. |
| `relay.secret` | `""` | The Worker's `RELAY_SECRET`, to sign tickets |
| `relay.existingSecret` | `""` | A Secret with `relay-secret` |
| `relay.ttlSeconds` | `21600` | How long a ticket opens connections |
| `relay.allowInsecure` | `false` | Allow a `ws://` URL. A page served over `https` can't open one. |

Deploy the Worker from the repository's `worker/` folder; its README has the steps.

### Service and ingress

| Value | Default | |
| --- | --- | --- |
| `service.type` | `ClusterIP` | |
| `service.port` | `8080` | |
| `ingress.enabled` | `false` | |
| `ingress.className` | `""` | |
| `ingress.host` | `drop.example.com` | |
| `ingress.annotations` | ingress-nginx proxy timeouts of 3600 s | Add your TLS issuer beside them. A key set to `null` removes a default. |
| `ingress.tls.enabled` | `true` | Keep it: browsers allow WebRTC and folder access only on secure pages |
| `ingress.tls.secretName` | `uploadmyshit-tls` | |

### Pod

| Value | Default | |
| --- | --- | --- |
| `terminationGracePeriodSeconds` | `20` | The shutdown delay, and a little more |
| `podAnnotations` | `{}` | |
| `podSecurityContext` | non-root (65532), `RuntimeDefault` seccomp | |
| `securityContext` | no privilege escalation, read-only root, no capabilities | |
| `resources` | requests 20m CPU and 32Mi; limit 256Mi memory | A few MB per thousand connections |
| `nodeSelector`, `tolerations`, `affinity` | empty | |

## What the chart refuses

- `ingress.enabled` without `ingress.host`.
- `ice.turn`:
  - URLs without credentials, or credentials without URLs;
  - a username without a credential;
  - static credentials and a secret together;
  - inline credentials and `existingSecret` together;
  - `ttlSeconds` below 600.
- `ice.cloudflare`: a key id without a token, or inline credentials and `existingSecret`
  together.
- `server.clientIpHeader` without any `server.trustedProxies`.
- `relay`:
  - a URL that isn't `wss://` (`ws://` only with `allowInsecure`);
  - a secret without a URL;
  - `secret` and `existingSecret` together;
  - `ttlSeconds` below 60.

## More

The repository's [docs/deployment.md](https://github.com/samuelleb11/UploadMyShit/blob/main/docs/deployment.md)
covers reverse proxies, Cloudflare, the relay, TURN and a post-install checklist.
