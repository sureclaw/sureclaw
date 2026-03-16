{{/*
Helm Preset Definitions for AX
===============================
Presets provide opinionated defaults for three deployment sizes: small, medium, large.
Resolution order: user override (non-null) > preset default > chart default.
A null value in values.yaml means "use preset or chart default".
When preset is empty, chart defaults are used (backward compatible).
*/}}

{{/*
ax.preset.hostReplicas — Host deployment replicas.
Preset: small=1, medium=2, large=3. Chart default: 2.
*/}}
{{- define "ax.preset.hostReplicas" -}}
{{- if not (kindIs "invalid" .Values.host.replicas) -}}
  {{- .Values.host.replicas -}}
{{- else -}}
  {{- $p := .Values.preset | default "" -}}
  {{- if eq $p "small" -}}1
  {{- else if eq $p "medium" -}}2
  {{- else if eq $p "large" -}}3
  {{- else -}}2{{- end -}}
{{- end -}}
{{- end -}}

{{/*
ax.preset.hostResources — Host deployment resources (YAML block).
Preset: small=250m/256Mi, medium/large=500m/512Mi. Chart default: 500m/512Mi.
*/}}
{{- define "ax.preset.hostResources" -}}
{{- if .Values.host.resources -}}
{{- toYaml .Values.host.resources -}}
{{- else -}}
{{- $p := .Values.preset | default "" -}}
{{- if eq $p "small" -}}
requests:
  cpu: "250m"
  memory: "256Mi"
limits:
  cpu: "250m"
  memory: "256Mi"
{{- else -}}
requests:
  cpu: "500m"
  memory: "512Mi"
limits:
  cpu: "500m"
  memory: "512Mi"
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
ax.preset.sandboxRuntimeClass — Container runtimeClass for agent pods.
Preset: small="" (no gvisor), medium/large=gvisor. Chart default: gvisor.
*/}}
{{- define "ax.preset.sandboxRuntimeClass" -}}
{{- if not (kindIs "invalid" .Values.sandbox.runtimeClass) -}}
  {{- .Values.sandbox.runtimeClass -}}
{{- else -}}
  {{- $p := .Values.preset | default "" -}}
  {{- if eq $p "small" -}}
  {{- else -}}gvisor{{- end -}}
{{- end -}}
{{- end -}}

{{/* Sandbox worker pod tiers removed — agents execute tools locally */}}
