#!/bin/sh
# check-chart.sh -- lint charts/uploadmyshit in each of its shapes, and prove that the
# configurations it must refuse are refused. CI's `check chart` runs this; so can you.
#
#   scripts/check-chart.sh
#
# A chart that renders a bad configuration fails later, in the cluster, less clearly.
# POSIX sh: it runs in the alpine/helm image and on a stock macOS.

set -eu
cd "$(dirname "$0")/.."
CHART=charts/uploadmyshit
OUT="${TMPDIR:-/tmp}/check-chart.$$"
mkdir -p "$OUT"
trap 'rm -rf "$OUT"' EXIT INT TERM

fail() { printf 'check-chart: %s\n' "$1" >&2; exit 1; }

# Each optional part lints.
helm lint "$CHART" >/dev/null
helm lint "$CHART" --set ingress.enabled=true >/dev/null
helm lint "$CHART" --set ice.turn.urls[0]=turn:turn.example.com:3478 --set ice.turn.secret=s3cret >/dev/null
helm lint "$CHART" --set ice.turn.urls[0]=turns:t.example.com:443 \
  --set ice.turn.username=u --set ice.turn.credential=p >/dev/null
helm lint "$CHART" --set ice.turn.urls[0]=turn:t.example.com --set ice.turn.existingSecret=turn >/dev/null
helm lint "$CHART" --set ice.cloudflare.keyId=k --set ice.cloudflare.apiToken=t >/dev/null
helm lint "$CHART" --set ice.cloudflare.existingSecret=cf >/dev/null
helm lint "$CHART" --set server.networkRooms=false >/dev/null
helm lint "$CHART" --set relay.url=wss://relay.example.workers.dev --set relay.secret=s >/dev/null
helm lint "$CHART" --set relay.url=wss://relay.example.workers.dev --set relay.existingSecret=relay >/dev/null
# Rancher installs every chart with a `global` block of its own (global.cattle.*).
helm lint "$CHART" --set global.cattle.clusterId=c-abc12 --set global.systemDefaultRegistry= >/dev/null

refused() {
  # $1: what it is; the rest: helm arguments that must not render.
  what=$1
  shift
  if helm template ci "$CHART" "$@" >/dev/null 2>&1; then
    fail "$what rendered; it must be refused"
  fi
}
refused "an ingress with no host" --set ingress.enabled=true --set ingress.host=
refused "TURN URLs without credentials" --set ice.turn.urls[0]=turn:t.example.com
refused "TURN credentials without URLs" --set ice.turn.secret=s
refused "static and shared-secret TURN credentials together" --set ice.turn.urls[0]=turn:t.example.com \
  --set ice.turn.secret=s --set ice.turn.username=u --set ice.turn.credential=p
refused "a TURN username without a password" --set ice.turn.urls[0]=turn:t.example.com --set ice.turn.username=u
refused "a TURN URL that is not one" --set ice.turn.urls[0]=https://t.example.com --set ice.turn.secret=s
refused "a STUN URL that is not one" --set ice.stunUrls[0]=stun.example.com
refused "half a Cloudflare key" --set ice.cloudflare.keyId=k
refused "a credential lifetime under ten minutes" --set ice.turn.ttlSeconds=60
refused "a shutdown delay the grace period cuts short" --set server.shutdownDelaySeconds=30
refused "a client-address header with no trusted proxy" --set server.trustedProxies=null
refused "a misspelt value" --set server.netwrokRooms=false
refused "a second replica" --set replicaCount=2
refused "a relay URL that is not a WebSocket" --set relay.url=https://relay.example.com
refused "an insecure relay URL" --set relay.url=ws://relay.example.com
refused "a relay secret without a relay" --set relay.secret=s
refused "two relay secrets" --set relay.url=wss://r.example.com --set relay.secret=s --set relay.existingSecret=x

# What the default renders: one replica, the probes, the trusted proxies, no secret.
helm template ci "$CHART" --namespace ci > "$OUT/default.yaml"
grep -q '^  replicas: 1$' "$OUT/default.yaml" || fail "the Deployment does not run exactly one replica"
grep -q 'path: /readyz' "$OUT/default.yaml" || fail "readiness is not /readyz"
grep -q 'value: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7"' "$OUT/default.yaml" \
  || fail "the trusted proxies are not passed"
grep -q 'readOnlyRootFilesystem: true' "$OUT/default.yaml" || fail "the root filesystem is writable"
! grep -q '^kind: Secret' "$OUT/default.yaml" || fail "a Secret rendered with no credentials given"

# Inline credentials land in a Secret and reach the server only through it.
helm template ci "$CHART" --set ice.cloudflare.keyId=kid --set ice.cloudflare.apiToken=tok > "$OUT/cf.yaml"
grep -q '^kind: Secret' "$OUT/cf.yaml" || fail "no Secret for the Cloudflare key"
grep -q 'api-token: "tok"' "$OUT/cf.yaml" || fail "the Cloudflare token is not in the Secret"
grep -q 'name: UMS_CLOUDFLARE_TURN_API_TOKEN' "$OUT/cf.yaml" || fail "the server is not given the Cloudflare token"
! grep -q 'value: "tok"' "$OUT/cf.yaml" || fail "the Cloudflare token is in the Deployment in the clear"

# The relay secret, like the others, reaches the server only through a Secret.
helm template ci "$CHART" --set relay.url=wss://r.example.com --set relay.secret=hush > "$OUT/relay.yaml"
grep -q 'relay-secret: "hush"' "$OUT/relay.yaml" || fail "the relay secret is not in the Secret"
grep -q 'name: UMS_RELAY_SECRET' "$OUT/relay.yaml" || fail "the server is not given the relay secret"
grep -q 'value: "wss://r.example.com"' "$OUT/relay.yaml" || fail "the server is not given the relay URL"
! grep -q 'value: "hush"' "$OUT/relay.yaml" || fail "the relay secret is in the Deployment in the clear"

# What `publish chart` runs, so a packaging failure stops a merge and not a publish.
scripts/package-chart.sh 0 "ci-check" registry.example.com/check/uploadmyshit "$OUT/pkg" >/dev/null

echo "check-chart: ok"
