#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS DMG finalization must run on macOS." >&2
  exit 1
fi

dmg_path="${1:-}"
if [[ -z "${dmg_path}" || ! -f "${dmg_path}" ]]; then
  echo "Pass the macOS DMG to finalize as the first argument." >&2
  exit 1
fi

for command_path in /usr/bin/SetFile /usr/bin/GetFileInfo; do
  if [[ ! -x "${command_path}" ]]; then
    echo "${command_path} is required to finalize the macOS DMG." >&2
    exit 1
  fi
done

dmg_directory="$(cd "$(dirname "${dmg_path}")" && pwd)"
dmg_path="${dmg_directory}/$(basename "${dmg_path}")"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
finder_metadata_script="${script_directory}/macos-dmg-finder.py"
work_directory="$(mktemp -d "${TMPDIR:-/tmp}/libre-webui-dmg-finalize.XXXXXX")"
read_write_image="${work_directory}/installer-read-write.dmg"
final_image="${work_directory}/installer-final.dmg"
mount_point="${work_directory}/mount"
mounted=false

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

mkdir "${mount_point}"

cleanup() {
  if [[ "${mounted}" == "true" ]]; then
    hdiutil detach "${mount_point}" -quiet || hdiutil detach "${mount_point}" -force || true
  fi
  for temporary_file in "${read_write_image}" "${final_image}"; do
    if [[ -e "${temporary_file}" ]]; then
      unlink "${temporary_file}" || true
    fi
  done
  rmdir "${mount_point}" 2>/dev/null || true
  rmdir "${work_directory}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Finalizing Finder metadata: ${dmg_path}"
hdiutil convert "${dmg_path}" -format UDRW -o "${read_write_image}" >/dev/null
hdiutil attach \
  -nobrowse \
  -readwrite \
  -mountpoint "${mount_point}" \
  "${read_write_image}" >/dev/null
mounted=true

app_path="$(find "${mount_point}" -maxdepth 1 -type d -name '*.app' -print -quit)"
background_path="$(find "${mount_point}" -maxdepth 1 -type f \( -name '.background.png' -o -name '.background.tiff' \) -print -quit)"
embedded_background="${app_path}/Contents/Resources/dmg-background.tiff"

if [[ -z "${app_path}" || -z "${background_path}" || ! -f "${embedded_background}" ]]; then
  echo "The DMG is missing its app or embedded Finder background." >&2
  exit 1
fi

"${dmg_python}" \
  "${finder_metadata_script}" \
  update \
  "${mount_point}/.DS_Store" \
  "${embedded_background}"

unlink "${background_path}"
if [[ -e "${mount_point}/.VolumeIcon.icns" ]]; then
  unlink "${mount_point}/.VolumeIcon.icns"
fi
/usr/bin/SetFile -a c "${mount_point}"
/usr/bin/SetFile -a V "${mount_point}/.DS_Store"

sync
hdiutil detach "${mount_point}" -quiet
mounted=false

hdiutil convert \
  "${read_write_image}" \
  -format UDZO \
  -imagekey zlib-level=9 \
  -o "${final_image}" >/dev/null
mv "${final_image}" "${dmg_path}"

echo "Finder metadata finalized."
