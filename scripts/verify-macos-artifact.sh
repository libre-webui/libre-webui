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

background_path="${app_path}/Contents/Resources/dmg-background.tiff"
if [[ ! -f "${background_path}" ]]; then
  echo "The disk image does not contain the branded installer background." >&2
  exit 1
fi

background_width="$(sips -g pixelWidth "${background_path}" | awk '/pixelWidth/ {print $2}')"
background_height="$(sips -g pixelHeight "${background_path}" | awk '/pixelHeight/ {print $2}')"
background_dpi="$(sips -g dpiWidth "${background_path}" | awk '/dpiWidth/ {print $2}')"
if [[ "${background_width}" != "760" || "${background_height}" != "500" ]]; then
  echo "The installer background must be 760x500, got ${background_width}x${background_height}." >&2
  exit 1
fi
if [[ "${background_dpi}" != "72.000" ]]; then
  echo "The installer background must use 72 DPI, got ${background_dpi}." >&2
  exit 1
fi

if [[ ! -L "${mount_point}/Applications" ]]; then
  echo "The disk image does not contain the Applications shortcut." >&2
  exit 1
fi

root_item_count="$(find "${mount_point}" -mindepth 1 -maxdepth 1 ! -name '.DS_Store' -print | wc -l | tr -d ' ')"
if [[ "${root_item_count}" != "2" ]]; then
  echo "The disk image root must contain only the app and Applications shortcut, got ${root_item_count} items." >&2
  exit 1
fi

if find "${mount_point}" -maxdepth 1 -type f \( -name '.background.png' -o -name '.background.tiff' -o -name '.VolumeIcon.icns' \) -print -quit | grep -q .; then
  echo "The disk image root must not expose Finder background or volume icon files." >&2
  exit 1
fi

if ! /usr/bin/GetFileInfo -a "${mount_point}/.DS_Store" | grep -q 'V'; then
  echo ".DS_Store must be Finder-invisible." >&2
  exit 1
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dmg_python="$(find \
  "${HOME}/Library/Caches/electron-builder" \
  -type f \
  -path '*/dmg-builder@*/dmgbuild-bundle-*/python/bin/python3.*' \
  ! -name '*-config' \
  -print \
  -quit)"
if [[ -z "${dmg_python}" ]]; then
  echo "Could not locate electron-builder's dmgbuild Python runtime." >&2
  exit 1
fi
"${dmg_python}" \
  "${script_directory}/macos-dmg-finder.py" \
  verify \
  "${mount_point}/.DS_Store" \
  "${background_path}"
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

if find "${app_path}/Contents" -type f -name 'dmg-art.png' -print -quit | grep -q .; then
  echo "The DMG source artwork must not be bundled inside the application." >&2
  exit 1
fi

echo "macOS artifact contains the branded 760x500 Retina installer background."
echo "macOS disk image root contains only the app and Applications shortcut."
echo "macOS artifact has a valid ad-hoc application signature."
