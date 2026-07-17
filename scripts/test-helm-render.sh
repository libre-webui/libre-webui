#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart_dir="$repo_root/helm/libre-webui"
override_digest="sha256:1111111111111111111111111111111111111111111111111111111111111111"
app_version="$(awk '/^appVersion:/ { print $2; exit }' "$chart_dir/Chart.yaml" | tr -d "\"'")"
configured_digest="$(awk '/^  digest:/ { print $2; exit }' "$chart_dir/values.yaml" | tr -d "\"'")"

if [[ -n "$configured_digest" ]]; then
  default_image="librewebui/libre-webui@$configured_digest"
else
  default_image="librewebui/libre-webui:$app_version"
fi

render_libre_image() {
  helm template libre-webui "$chart_dir" "$@" |
    awk '$1 == "image:" && $2 ~ /librewebui\/libre-webui/ { gsub(/"/, "", $2); print $2; exit }'
}

render_ollama_image() {
  helm template libre-webui "$chart_dir" "$@" |
    awk '$1 == "image:" && $2 ~ /ollama\/ollama/ { gsub(/"/, "", $2); print $2; exit }'
}

assert_image() {
  local label="$1"
  local actual="$2"
  local expected="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "$label rendered $actual; expected $expected" >&2
    exit 1
  fi
}

assert_image \
  "default image" \
  "$(render_libre_image)" \
  "$default_image"

assert_image \
  "explicit tag override" \
  "$(render_libre_image --set-string image.tag=custom)" \
  "librewebui/libre-webui:custom"

assert_image \
  "explicit digest override" \
  "$(render_libre_image --set-string image.tag= --set-string image.digest="$override_digest")" \
  "librewebui/libre-webui@$override_digest"

assert_image \
  "appVersion fallback" \
  "$(render_libre_image --set-string image.tag= --set-string image.digest=)" \
  "librewebui/libre-webui:$app_version"

assert_image \
  "bundled Ollama default" \
  "$(render_ollama_image)" \
  "ollama/ollama:latest"

echo "Helm image resolution checks passed."
