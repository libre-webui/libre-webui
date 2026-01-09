{{/*
Expand the name of the chart.
*/}}
{{- define "libre-webui.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "libre-webui.fullname" -}}
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
Create chart name and version as used by the chart label.
*/}}
{{- define "libre-webui.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "libre-webui.labels" -}}
helm.sh/chart: {{ include "libre-webui.chart" . }}
{{ include "libre-webui.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "libre-webui.selectorLabels" -}}
app.kubernetes.io/name: {{ include "libre-webui.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "libre-webui.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "libre-webui.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Ollama URL - either external or bundled service
*/}}
{{- define "libre-webui.ollamaUrl" -}}
{{- if .Values.ollama.external.enabled }}
{{- .Values.ollama.external.url }}
{{- else if .Values.ollama.bundled.enabled }}
{{- printf "http://%s-ollama:11434" (include "libre-webui.fullname" .) }}
{{- else }}
{{- "http://localhost:11434" }}
{{- end }}
{{- end }}
