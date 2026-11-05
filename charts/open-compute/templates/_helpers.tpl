{{- define "open-compute.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "open-compute.fullname" -}}
{{- /* Reserve nine characters for the headless Service suffix. */ -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 54 | trimSuffix "-" -}}
{{- else if contains (include "open-compute.name" .) .Release.Name -}}
{{- .Release.Name | trunc 54 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "open-compute.name" .) | trunc 54 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "open-compute.selectorLabels" -}}
app.kubernetes.io/name: {{ include "open-compute.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "open-compute.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{ include "open-compute.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "open-compute.image" -}}
{{- if .image.digest -}}
{{- printf "%s@%s" .image.repository .image.digest -}}
{{- else -}}
{{- printf "%s:%s" .image.repository (default .appVersion .image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "open-compute.s3Env" -}}
{{- if eq .Values.storage.backend "s3" }}
- name: OC_S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ required "storage.s3.existingSecret is required for S3" .Values.storage.s3.existingSecret }}
      key: {{ .Values.storage.s3.accessKeyIdKey }}
- name: OC_S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.storage.s3.existingSecret }}
      key: {{ .Values.storage.s3.secretAccessKeyKey }}
{{- end }}
{{- end -}}
