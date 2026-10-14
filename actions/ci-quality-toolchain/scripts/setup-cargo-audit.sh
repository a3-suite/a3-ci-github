#!/usr/bin/env bash
set -euo pipefail

fail() { echo "quality-toolchain-cargo-audit-$1" >&2; exit 1; }
version=${CI_CARGO_AUDIT_VERSION:-}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || fail version-invalid

target=''
binary=cargo-audit
extension=tgz
archive_tool=tar
system=$(uname -s)
machine=$(uname -m)
case "$system/$machine" in
  Darwin/arm64) target=aarch64-apple-darwin ;;
  Darwin/x86_64) target=x86_64-apple-darwin ;;
  Linux/x86_64|Linux/aarch64)
    libc=''
    if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then libc=gnu
    else
      libc_output=$(ldd --version 2>&1 || true)
      if [[ "$libc_output" == *musl* ]]; then libc=musl; fi
    fi
    if [[ "$libc" == gnu ]]; then
      if [[ "$machine" == x86_64 ]]; then target=x86_64-unknown-linux-gnu; else target=aarch64-unknown-linux-gnu; fi
    elif [[ "$libc" == musl && "$machine" == x86_64 ]]; then target=x86_64-unknown-linux-musl; fi
    ;;
  MINGW*/x86_64|MSYS*/x86_64)
    target=x86_64-pc-windows-msvc; binary=cargo-audit.exe; extension=zip; archive_tool=tar.exe
    ;;
esac

asset="cargo-audit-$target-v$version.$extension"
expected=''
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
while read -r digest name extra; do
  if [[ -n "$target" && "$name" == "$asset" ]]; then
    [[ -z "$expected" && -z "$extra" && "$digest" =~ ^[0-9a-f]{64}$ ]] || fail digest-invalid
    expected=$digest
  fi
done < "$script_directory/cargo-audit-sha256sums.txt"
if [[ -z "$expected" ]]; then
  echo "cargo-audit $version: no pinned binary for this target; installing from source"
  exec cargo install cargo-audit --locked --version "$version"
fi

[[ -n "${RUNNER_TEMP:-}" && -n "${GITHUB_PATH:-}" ]] || fail runner-path-missing
temp_root=$RUNNER_TEMP
github_path=$GITHUB_PATH
if [[ "$extension" == zip ]]; then
  temp_root=$(cygpath -u "$temp_root")
  github_path=$(cygpath -u "$github_path")
  [[ -n "${SYSTEMROOT:-}" ]] || fail windows-system-root-missing
  # Git Bash also supplies GNU tar.exe, which cannot read ZIP archives.
  archive_tool="$(cygpath -u "$SYSTEMROOT")/System32/tar.exe"
fi
directory=$(mktemp -d "$temp_root/cargo-audit-bin-XXXXXX")
retain=false
# The directory contains only this invocation's archive and executable.
cleanup() {
  if [[ "$retain" != true ]]; then
    [[ ! -f "$directory/$asset" ]] || unlink "$directory/$asset"
    [[ ! -f "$directory/$binary" ]] || unlink "$directory/$binary"
    rmdir "$directory"
  fi
}
trap cleanup EXIT
url="https://github.com/rustsec/rustsec/releases/download/cargo-audit/v$version/$asset"
curl --fail --location --silent --show-error --connect-timeout 10 --max-time 60 --output "$directory/$asset" "$url" || fail download-failed
if command -v sha256sum >/dev/null 2>&1; then
  observed=$(sha256sum "$directory/$asset")
else
  observed=$(shasum -a 256 "$directory/$asset")
fi
[[ "${observed%% *}" == "$expected" ]] || fail checksum-mismatch
# Extract only the executable after the complete archive has passed its digest check.
"$archive_tool" -xOf "$directory/$asset" "cargo-audit-$target-v$version/$binary" > "$directory/$binary" || fail extraction-failed
[[ -s "$directory/$binary" ]] || fail extraction-failed
chmod 700 "$directory/$binary"
unlink "$directory/$asset"
observed=$("$directory/$binary" --version) || fail version-mismatch
observed=${observed%$'\r'}
[[ "$observed" == "cargo-audit $version" ]] || fail version-mismatch
export_directory=$directory
if [[ "$extension" == zip ]]; then export_directory=$(cygpath -w "$directory"); fi
printf '%s\n' "$export_directory" >> "$github_path"
retain=true
echo "cargo-audit $version: installed verified $target binary"
