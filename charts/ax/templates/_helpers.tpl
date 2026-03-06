{{/*
Expand the name of the chart.
*/}}
{{- define "ax.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "ax.fullname" -}}
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

{{/*
Chart label values.
*/}}
{{- define "ax.labels" -}}
helm.sh/chart: {{ include "ax.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ax
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end }}

{{/*
Chart name and version for chart label.
*/}}
{{- define "ax.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Component labels — call with (dict "component" "host" "context" $)
*/}}
{{- define "ax.componentLabels" -}}
{{ include "ax.labels" .context }}
app.kubernetes.io/name: {{ include "ax.fullname" .context }}-{{ .component }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Selector labels for a component — call with (dict "component" "host" "context" $)
*/}}
{{- define "ax.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ax.fullname" .context }}-{{ .component }}
{{- end }}

{{/*
Container image string for a component.
Call with (dict "image" .Values.host.image "global" .Values.global "context" $)
*/}}
{{- define "ax.image" -}}
{{- $registry := .image.registry | default .global.imageRegistry | default "" -}}
{{- $repo := .image.repository -}}
{{- $tag := .image.tag | default .global.imageTag | default .context.Chart.AppVersion -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end }}

{{/*
NATS URL — uses subchart service if enabled, otherwise external URL.
*/}}
{{- define "ax.natsUrl" -}}
{{- if .Values.nats.enabled -}}
nats://{{ include "ax.fullname" . }}-nats.{{ .Release.Namespace }}.svc.cluster.local:4222
{{- else -}}
{{ .Values.nats.externalUrl | default "nats://nats:4222" }}
{{- end -}}
{{- end }}

{{/*
DATABASE_URL env block — renders the correct env vars for external or internal PostgreSQL.
Include with: {{ include "ax.databaseEnv" . | nindent <N> }}
*/}}
{{- define "ax.databaseEnv" -}}
{{- if .Values.postgresql.external.enabled }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgresql.external.existingSecret | default "ax-db-credentials" }}
      key: {{ .Values.postgresql.external.secretKey | default "url" }}
{{- else }}
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "ax.fullname" . }}-postgresql
      key: postgres-password
- name: DATABASE_URL
  value: "postgresql://{{ .Values.postgresql.internal.auth.username | default "postgres" }}:$(PGPASSWORD)@{{ include "ax.fullname" . }}-postgresql:5432/{{ .Values.postgresql.internal.auth.database | default "ax" }}"
{{- end -}}
{{- end }}

{{/*
Namespace — use .Values.namespace.name or Release.Namespace.
*/}}
{{- define "ax.namespace" -}}
{{- .Values.namespace.name | default .Release.Namespace -}}
{{- end }}

{{/*
AX plane label for network policy selectors.
*/}}
{{- define "ax.planeLabel" -}}
ax.io/plane: {{ . }}
{{- end }}

{{/*
NATS JetStream stream replicas — matches cluster size, or 1 if clustering disabled.
*/}}
{{- define "ax.natsReplicas" -}}
{{- if .Values.nats.config.cluster.enabled -}}
{{- .Values.nats.config.cluster.replicas | default 1 -}}
{{- else -}}
1
{{- end -}}
{{- end }}
