#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS artifact verification must run on macOS." >&2
  exit 1
fi

dmg_path="${1:-}"
if [[ -z "${dmg_path}" ]]; then
  if [[ ! -d dist-electron ]]; then
    echo "The dist-electron directory does not exist. Build the macOS app first." >&2
    exit 1
  fi
  dmg_path="$(find dist-electron -maxdepth 1 -type f -name '*-mac-arm64.dmg' -print -quit)"
fi

if [[ -z "${dmg_path}" || ! -f "${dmg_path}" ]]; then
  echo "No macOS ARM64 DMG was found to verify." >&2
  exit 1
fi

mount_point="$(mktemp -d "${TMPDIR:-/tmp}/libre-webui-dmg.XXXXXX")"
mounted=false

cleanup() {
  if [[ "${mounted}" == "true" ]]; then
    hdiutil detach "${mount_point}" -quiet || true
  fi
  rmdir "${mount_point}" 2>/dev/null || true
}
trap cleanup EXIT

echo "Verifying disk image checksum: ${dmg_path}"
hdiutil verify "${dmg_path}"

echo "Mounting disk image read-only"
hdiutil attach -nobrowse -readonly -mountpoint "${mount_point}" "${dmg_path}" >/dev/null
mounted=true

app_path="$(find "${mount_point}" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [[ -z "${app_path}" ]]; then
  echo "The disk image does not contain a macOS application bundle." >&2
  exit 1
fi

echo "Verifying application bundle: ${app_path}"
codesign --verify --deep --strict --verbose=2 "${app_path}"

signature_details="$(codesign -dv --verbose=4 "${app_path}" 2>&1)"
printf '%s\n' "${signature_details}"

if ! grep -q '^Identifier=com\.librewebui\.app$' <<<"${signature_details}"; then
  echo "The application bundle has an unexpected signing identifier." >&2
  exit 1
fi

if ! grep -q '^Signature=adhoc$' <<<"${signature_details}"; then
  echo "The application bundle is not using the expected ad-hoc signature." >&2
  exit 1
fi

echo "macOS artifact has a valid ad-hoc application signature."
