{{/*
Names and labels.
*/}}
{{- define "uploadmyshit.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "uploadmyshit.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "uploadmyshit.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "uploadmyshit.selectorLabels" -}}
app.kubernetes.io/name: {{ include "uploadmyshit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "uploadmyshit.labels" -}}
helm.sh/chart: {{ include "uploadmyshit.chart" . }}
{{ include "uploadmyshit.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "uploadmyshit.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/*
The Secret holding TURN and Cloudflare credentials given inline in the values, when there
are any. Empty when there are none.
*/}}
{{- define "uploadmyshit.iceSecretName" -}}
{{- $t := .Values.ice.turn }}
{{- $c := .Values.ice.cloudflare }}
{{- if or $t.username $t.credential $t.secret $c.keyId $c.apiToken }}
{{- printf "%s-ice" (include "uploadmyshit.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
The configuration is checked here, once, and a bad one fails the render with a sentence.
A chart that renders a Deployment which then crash-loops says the same thing later and
less clearly.
*/}}
{{- define "uploadmyshit.validate" -}}
{{- $t := .Values.ice.turn }}
{{- $c := .Values.ice.cloudflare }}
{{- if and .Values.ingress.enabled (not .Values.ingress.host) }}
{{- fail "ingress.enabled is true but ingress.host is empty" }}
{{- end }}
{{- $static := or $t.username $t.credential }}
{{- if and $static $t.secret }}
{{- fail "ice.turn: give either username and credential, or secret, not both" }}
{{- end }}
{{- if and $static (not (and $t.username $t.credential)) }}
{{- fail "ice.turn.username and ice.turn.credential go together" }}
{{- end }}
{{- if and $t.urls (not (or $static $t.secret $t.existingSecret)) }}
{{- fail "ice.turn.urls needs credentials (username and credential, secret, or existingSecret): browsers refuse a TURN server without them" }}
{{- end }}
{{- if and (not $t.urls) (or $static $t.secret $t.existingSecret) }}
{{- fail "ice.turn credentials are given but ice.turn.urls is empty" }}
{{- end }}
{{- range $t.urls }}
{{- if not (or (hasPrefix "turn:" .) (hasPrefix "turns:" .)) }}
{{- fail (printf "ice.turn.urls: %q does not start with turn: or turns:" .) }}
{{- end }}
{{- end }}
{{- range .Values.ice.stunUrls }}
{{- if not (or (hasPrefix "stun:" .) (hasPrefix "stuns:" .)) }}
{{- fail (printf "ice.stunUrls: %q does not start with stun: or stuns:" .) }}
{{- end }}
{{- end }}
{{- if and (or $c.keyId $c.apiToken) (not (and $c.keyId $c.apiToken)) }}
{{- fail "ice.cloudflare.keyId and ice.cloudflare.apiToken go together" }}
{{- end }}
{{- if and $c.existingSecret (or $c.keyId $c.apiToken) }}
{{- fail "ice.cloudflare: give either keyId and apiToken, or existingSecret, not both" }}
{{- end }}
{{- if and $t.existingSecret (or $static $t.secret) }}
{{- fail "ice.turn: give inline credentials or existingSecret, not both" }}
{{- end }}
{{- if lt (int64 $t.ttlSeconds) 600 }}
{{- fail "ice.turn.ttlSeconds below 600 would expire mid-transfer" }}
{{- end }}
{{- if and .Values.server.clientIpHeader (not .Values.server.trustedProxies) }}
{{- fail "server.clientIpHeader is only read from server.trustedProxies; list at least one" }}
{{- end }}
{{- if ge (add (int64 .Values.server.shutdownDelaySeconds) 2) (int64 .Values.terminationGracePeriodSeconds) }}
{{- fail (printf "server.shutdownDelaySeconds (%d) and 2 s to close connections must end before terminationGracePeriodSeconds (%d)" (int64 .Values.server.shutdownDelaySeconds) (int64 .Values.terminationGracePeriodSeconds)) }}
{{- end }}
{{- end }}
