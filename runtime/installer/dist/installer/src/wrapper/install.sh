#!/bin/sh
# Shared Unix wrapper: detect the platform, verify the platform installer
# payload, then run it. Keep this script POSIX sh compatible so it can be
# piped to sh from a fixed HTTPS URL.
set -eu

wrapper_version=1

usage() {
  printf '%s\n' 'usage: install.sh (POSIX sh wrapper; defaults: install/online)'
  printf '%s\n' 'env: INSTALLER_MODE, INSTALLER_SOURCE, INSTALLER_MANIFEST, INSTALLER_ARTIFACT, INSTALLER_SMOKE_HELP, INSTALLER_JSON'
}
fail() { printf 'installer error: %s\n' "$1" >&2; exit 2; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail 'sha256sum or shasum is required'
  fi
}

quote_arg() {
  # POSIX sh で任意の引数を再実行可能な1トークンへ変換する。
  quoted="'"
  rest=$1
  while :; do
    case $rest in
      *\'*)
        quoted="$quoted${rest%%\'*}'\\''"
        rest=${rest#*\'}
        ;;
      *) break ;;
    esac
  done
  printf "%s%s'\n" "$quoted" "$rest"
}

case "${1-}" in
  --help|-h) usage; exit 0 ;;
  --version) printf '%s\n' "$wrapper_version"; exit 0 ;;
esac

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x86_64 ;;
  Darwin-arm64) platform=macos-arm64 ;;
  *) fail 'unsupported target platform' ;;
esac

# __INSTALLER_RUNTIME_VALUES__

case "$platform" in
  linux-x86_64)
    installer_url=${P_linux_x86_64_INSTALLER_URL:-}
    installer_checksum=${P_linux_x86_64_INSTALLER_CHECKSUM:-}
    ;;
  macos-arm64)
    installer_url=${P_macos_arm64_INSTALLER_URL:-}
    installer_checksum=${P_macos_arm64_INSTALLER_CHECKSUM:-}
    ;;
  *) fail 'unsupported target platform' ;;
esac

[ -n "$installer_url" ] || fail 'missing platform installer url'
[ -n "$installer_checksum" ] || fail 'missing platform installer checksum'
[ "${#installer_checksum}" -eq 64 ] || fail 'invalid platform installer checksum'
case "$installer_checksum" in
  *[!0-9a-fA-F]*) fail 'invalid platform installer checksum' ;;
esac
case "$installer_url" in
  https://*) ;;
  *) fail 'platform installer url must be https' ;;
esac
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v bash >/dev/null 2>&1 || fail 'bash is required'

work=$(mktemp -d)
cleanup() {
  status=$?
  trap - 0
  rm -rf "$work" 2>/dev/null || true
  exit "$status"
}
trap cleanup 0

installer_path="$work/platform-installer.sh"
curl --fail --silent --show-error --location --max-redirs 5 \
  --proto '=https' --proto-redir '=https' \
  --output "$installer_path" "$installer_url" || fail 'platform installer download failed'
actual_checksum=$(sha256_file "$installer_path")
[ "$actual_checksum" = "$installer_checksum" ] || fail 'platform installer checksum mismatch'

set --
if [ -n "${INSTALLER_MODE:-}" ]; then set -- "$@" --mode "$INSTALLER_MODE"; fi
if [ -n "${INSTALLER_SOURCE:-}" ]; then set -- "$@" --source "$INSTALLER_SOURCE"; fi
if [ -n "${INSTALLER_MANIFEST:-}" ]; then set -- "$@" --manifest "$INSTALLER_MANIFEST"; fi
if [ -n "${INSTALLER_ARTIFACT:-}" ]; then set -- "$@" --artifact "$INSTALLER_ARTIFACT"; fi
if [ "${INSTALLER_SMOKE_HELP:-0}" = "1" ]; then set -- "$@" --smoke-help; fi
if [ "${INSTALLER_JSON:-0}" = "1" ]; then set -- "$@" --json; fi

# 引数を runner へ確定してから実行し、配信の切断で引数が欠落した起動を成立させない。
runner="$work/platform-installer-runner.sh"
{
  printf '%s\n' '#!/bin/sh'
  printf 'exec bash %s' "$(quote_arg "$installer_path")"
  for argument do printf ' %s' "$(quote_arg "$argument")"; done
  printf '\n'
} > "$runner" || fail 'runner creation failed'
sh "$runner"
