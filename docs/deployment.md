# Deployment

The server is one static binary that keeps everything in memory and writes nothing to disk.
In front of it you need TLS. Optionally, add a relay Worker on Cloudflare, a TURN service,
or both.

- [What it needs](#what-it-needs)
- [Docker](#docker)
- [Kubernetes](#kubernetes)
- [Visitor addresses and network rooms](#visitor-addresses-and-network-rooms)
- [Behind Cloudflare](#behind-cloudflare)
- [The relay Worker](#the-relay-worker)
- [TURN](#turn)
- [CI/CD](#cicd)
- [Upgrades](#upgrades)
- [After deploying: a checklist](#after-deploying-a-checklist)

## What it needs

- **TLS.** Browsers allow WebRTC, folder access and the clipboard only on secure pages.
- **WebSockets** through every proxy in front, for `/ws`. Pages ping every 20 seconds, so
  ordinary idle timeouts are fine.
- **One replica.** Rooms live in the process's memory. Two replicas would split each room
  into halves that can't see each other. One is plenty, because the server only passes
  small messages. File data never reaches it.
- **Very little compute.** A few MB of memory per thousand connections.
- **The visitor's real address**, if you keep network rooms on. See
  [below](#visitor-addresses-and-network-rooms).

Every setting is a flag and an environment variable, listed in
[configuration.md](configuration.md).

## Docker

```sh
docker build -t uploadmyshit .
docker run -p 8080:8080 \
  -e UMS_RELAY_URL=wss://<your-worker>.<your-subdomain>.workers.dev \
  -e UMS_RELAY_SECRET=... \
  uploadmyshit
```

The image is distroless. It runs as `nonroot` (65532), works with a read-only root
filesystem, and defaults to `UMS_BIND=0.0.0.0:8080` and JSON logs. A build argument,
`UMS_BUILD_SHA`, adds the commit to the version shown in the page's footer and in
`/healthz`.

## Kubernetes

The Helm chart is in [charts/uploadmyshit](../charts/uploadmyshit). Its README lists
every value. Build the image, push it to a registry your cluster can pull from, then:

```sh
helm upgrade --install uploadmyshit charts/uploadmyshit \
  --namespace uploadmyshit --create-namespace \
  --values my-values.yaml
```

A minimal `my-values.yaml` behind ingress-nginx with cert-manager:

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
  existingSecret: uploadmyshit-relay    # key: relay-secret (the Worker's RELAY_SECRET)
```

```sh
kubectl -n uploadmyshit create secret generic uploadmyshit-relay --from-literal=relay-secret=...
```

The chart checks its values when it renders. For example, it refuses a TURN server
without credentials, or a relay secret without a relay URL. After an install, its notes
say what to check. `helm test` fetches `/healthz` and the page through the Service.

**Rancher**, and other tools that add a top-level `global:` block to every install, work
as they are: the chart's schema accepts that block.

## Visitor addresses and network rooms

A network room holds every device behind one public address: one IPv4 address, or one
IPv6 `/64`. That only works if the server sees each visitor's own address. When it
instead sees a proxy's address for everyone, **every visitor lands in one room**, and
strangers see each other's devices.

| In front of the server | Set |
| --- | --- |
| Nothing (it terminates TLS itself, or a TCP load balancer passes connections through) | Nothing |
| An HTTP reverse proxy or ingress controller | `UMS_CLIENT_IP_HEADER=x-forwarded-for` and `UMS_TRUSTED_PROXIES=<the proxies' addresses>` (the chart's defaults: the header, and the private ranges) |
| Cloudflare: proxied DNS, or a Cloudflare Tunnel | `UMS_CLIENT_IP_HEADER=cf-connecting-ip`, with `UMS_TRUSTED_PROXIES` covering whatever connects to the server (chart: `server.clientIpHeader: cf-connecting-ip`) |

How the header is read:
- **Only from trusted proxies.** It is read only when the TCP peer is a trusted proxy.
  From anyone else it is ignored, so visitors can't choose their own room.
- **Right-most untrusted entry.** In `X-Forwarded-For`, the server takes the right-most
  entry that isn't a trusted proxy.
- **The proxy must see real addresses.** The ingress controller itself must see visitors'
  real addresses. With ingress-nginx, that means its Service uses
  `externalTrafficPolicy: Local`, or the load balancer sends the PROXY protocol.

**The server catches Cloudflare's version of this mistake.** Behind Cloudflare, an ingress
controller often rewrites `X-Forwarded-For` to the address of whatever connected to it,
such as the tunnel's pod. `CF-Connecting-IP` survives the rewrite. When it disagrees with
the address the server worked out:
- the visitor is put in no network room (the page shows "Not in a room" and offers a
  private one);
- the server logs this warning once:

  ```
  visitors come through Cloudflare, but the address worked out for them is 10.42.0.9, not
  the one Cloudflare saw: a proxy in between hides it. ...
  ```

Set `cf-connecting-ip` and the warning stops.

**Check it** after every change in front of the server. Open the page on two different
networks, for example a phone with Wi-Fi off and a computer. They must not see each other.
Two devices on the same Wi-Fi must.

Some cases these settings can't fix:
- **Shared public IPv4 addresses.** Mobile carriers, some ISPs and VPN exits put many
  customers behind one address (carrier-grade NAT). Network rooms then group strangers
  behind the same address. This is inherent to grouping by public address, and ShareDrop
  behaves the same. Transfers still need the receiver's consent. If you can't accept it,
  set `UMS_NETWORK_ROOMS=false`: only private rooms then exist.
- **IPv4 and IPv6 in one home.** A device that reaches the server over IPv6 and one that
  reaches it over IPv4 have different addresses, so they land in different rooms. Use a
  private room for those.

## Behind Cloudflare

Proxied DNS and Cloudflare Tunnels both work. WebSockets pass through by default. Check
these three things:

1. **Visitor addresses:** `cf-connecting-ip`, as [above](#visitor-addresses-and-network-rooms).
2. **Browser Cache TTL:** set it to **Respect Existing Headers**, under Caching →
   Configuration. Cloudflare's default rewrites the page's `Cache-Control: no-cache` to
   several hours, so browsers keep showing an old page after a deploy.

   The page is built to survive this anyway:
   - its scripts are under versioned URLs, so a stale page never runs with new scripts or
     the reverse;
   - a stale tab reloads itself once it connects.

   Respecting the headers still gets new visitors the new page at once.
3. **A tunnel can point at the Service or at the ingress controller.** If it points at the
   ingress, make sure the ingress's address is in the trusted proxies. It is by default,
   since it's in the private ranges.

You don't need Development Mode to deploy.

## The relay Worker

Some pairs of devices can't connect directly. This happens with symmetric NATs, which
are common on mobile and some corporate networks. The relay is a small Cloudflare Worker
you deploy to your own account. It carries their data, end-to-end encrypted. It also
speeds up large transfers, by adding lanes beside a direct connection when that's faster.

Deploying it is covered in [worker/README.md](../worker/README.md). Then give the server
its address and secret:

| | Environment | Chart |
| --- | --- | --- |
| Address | `UMS_RELAY_URL=wss://<your-worker>.<your-subdomain>.workers.dev` | `relay.url` |
| Secret | `UMS_RELAY_SECRET` (the Worker's `RELAY_SECRET`) | `relay.secret`, or `relay.existingSecret` with key `relay-secret` |

The server adds the Worker's origin to the page's Content-Security-Policy. Without a
secret, the Worker relays for anyone who knows its address, so set one.

## TURN

TURN relays WebRTC itself, through a TURN server. With the relay Worker deployed, TURN is
optional: a connection that lands on TURN hands its data to the relay at once. STUN is
separate and always needed. It is how a browser finds its public address for a direct
connection. The defaults are Cloudflare's and Google's public STUN servers.

Any one of these:

| | Environment | Chart |
| --- | --- | --- |
| Cloudflare Realtime TURN: the server fetches short-lived credentials and caches them for half their lifetime | `UMS_CLOUDFLARE_TURN_KEY_ID`, `UMS_CLOUDFLARE_TURN_API_TOKEN` | `ice.cloudflare.keyId`/`apiToken`, or `existingSecret` with keys `key-id`, `api-token` |
| coturn, or any server with the TURN REST shared-secret scheme: per-device credentials that expire | `UMS_TURN_URLS`, `UMS_TURN_SECRET`, `UMS_TURN_TTL` | `ice.turn.urls`, `secret`, `ttlSeconds` |
| Static credentials | `UMS_TURN_URLS`, `UMS_TURN_USERNAME`, `UMS_TURN_CREDENTIAL` | `ice.turn.urls`, `username`, `credential` |

Make generated credentials outlive the longest transfer. A TURN allocation can't be
refreshed once its credentials expire.

## CI/CD

[.gitlab-ci.yml](../.gitlab-ci.yml) is a GitLab pipeline. The project's public mirror on
GitHub carries `main`.

| Stage | Jobs |
| --- | --- |
| check | Rust fmt, clippy and tests; the page's unit tests; the two-browser end-to-end test, with a local relay; the chart's lint and render checks |
| build, tag | An image per commit, tagged with the commit, and `latest` on `main` |
| publish | The chart, packaged for the commit's image: `dev` from `dev`, `stable` from `main` |
| deploy | On `main`: `helm upgrade` at the commit's own image tag, then `helm test` |

CI/CD variables:

| Variable | |
| --- | --- |
| `CI_TEMPLATES_PROJECT` | The shared template project the image jobs come from. It isn't part of this repository; elsewhere, replace those jobs with your own `docker build` and push. |
| `DEPLOY_TOKEN_USER`, `DEPLOY_TOKEN` | Registry login, as the template expects |
| `UPLOADMYSHIT_VALUES` | A file variable: your chart values for the deploy |
| `KUBE_CONTEXT` | Optional: the kube context to deploy with |

Deploying the commit's own image tag means a rollback rolls back the binary, not just the
manifest. To update `main` without the deploy job, push with `-o ci.skip`.

## Upgrades

Rolling out a new version needs no downtime planning:

1. The old instance fails readiness and keeps serving for `UMS_SHUTDOWN_DELAY` seconds.
2. It then closes every connection with `bye: restart`, and pages reconnect to the new
   instance.
3. Transfers already running are browser to browser and carry on.
4. Tabs that were open on the old page reload themselves, once their transfers finish.
5. Devices still on an old page appear to the others as **outdated, reload it**.

## After deploying: a checklist

1. The page loads over `https://`, and its footer shows the version you deployed.
2. `/healthz` answers `{"status":"ok",…}`.
3. Two devices on one network see each other. Two on different networks don't. The log
   has no "visitors come through Cloudflare" warning.
4. A private room joins two devices on different networks, by link or QR code.
5. Settings → Diagnostics → Run network test finds a public (srflx) address through STUN.
6. With a relay: tick "Always use the relay" in Diagnostics on one device and send a file.
   It arrives, and Diagnostics shows the route as "Through the relay".
