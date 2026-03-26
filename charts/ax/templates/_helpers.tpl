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
Call with (dict "image" .Values.host.image "imageDefaults" .Values.imageDefaults "context" $)
*/}}
{{- define "ax.image" -}}
{{- $registry := .image.registry | default .imageDefaults.registry | default "" -}}
{{- $repo := .image.repository -}}
{{- $tag := .image.tag | default .imageDefaults.tag | default .context.Chart.AppVersion -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end }}

{{/*
Container image pull policy for a component.
Call with (dict "image" .Values.host.image "imageDefaults" .Values.imageDefaults)
Returns the pullPolicy if set, otherwise omits it (letting k8s use its default).
*/}}
{{- define "ax.imagePullPolicy" -}}
{{- $policy := .image.pullPolicy | default .imageDefaults.pullPolicy | default "" -}}
{{- if $policy -}}
imagePullPolicy: {{ $policy }}
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
{{- $pgUser := .Values.postgresql.auth.username | default "postgres" }}
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "ax.fullname" . }}-postgresql
      key: {{ if eq $pgUser "postgres" }}postgres-password{{ else }}password{{ end }}
- name: DATABASE_URL
  value: "postgresql://{{ $pgUser }}:$(PGPASSWORD)@{{ include "ax.fullname" . }}-postgresql:5432/{{ .Values.postgresql.auth.database | default "ax" }}"
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

