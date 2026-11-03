{{/*
Expand the chart name.
*/}}
{{- define "k8s-fleet-dashboard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name.
*/}}
{{- define "k8s-fleet-dashboard.fullname" -}}
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
Chart label value.
*/}}
{{- define "k8s-fleet-dashboard.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "k8s-fleet-dashboard.labels" -}}
helm.sh/chart: {{ include "k8s-fleet-dashboard.chart" . }}
{{ include "k8s-fleet-dashboard.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
Selector labels. Never change these without a Deployment recreation.
*/}}
{{- define "k8s-fleet-dashboard.selectorLabels" -}}
app.kubernetes.io/name: {{ include "k8s-fleet-dashboard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "k8s-fleet-dashboard.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "k8s-fleet-dashboard.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
ClusterRole name.
*/}}
{{- define "k8s-fleet-dashboard.clusterRoleName" -}}
{{- default (printf "%s-reader" (include "k8s-fleet-dashboard.fullname" .)) .Values.rbac.clusterRole.name }}
{{- end }}

{{/*
Image reference, tolerating an empty tag.
*/}}
{{- define "k8s-fleet-dashboard.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) }}
{{- end }}
