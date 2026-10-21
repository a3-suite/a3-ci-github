#!/usr/bin/env bash
set -euo pipefail

fail() { echo "quality-toolchain-cargo-deny-$1" >&2; exit 1; }
version=${CI_CARGO_DENY_VERSION:-}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || fail version-invalid

target=''
binary=cargo-deny
system=$(uname -s)
machine=$(uname -m)
case "$system/$machine" in
  Darwin/arm64) target=aarch64-apple-darwin ;;
  Darwin/x86_64) target=x86_64-apple-darwin ;;
  # Upstream publishes only statically linked musl builds for Linux, which also run on glibc runners.
  Linux/x86_64) target=x86_64-unknown-linux-musl ;;
  Linux/aarch64) target=aarch64-unknown-linux-musl ;;
  MINGW*/x86_64|MSYS*/x86_64) target=x86_64-pc-windows-msvc; binary=cargo-deny.exe ;;
esac

stem="cargo-deny-$version-$target"
asset="$stem.tar.gz"
expected=''
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
while read -r digest name extra; do
  if [[ -n "$target" && "$name" == "$asset" ]]; then
    [[ -z "$expected" && -z "$extra" && "$digest" =~ ^[0-9a-f]{64}$ ]] || fail digest-invalid
    expected=$digest
  fi
done < "$script_directory/cargo-deny-sha256sums.txt"
if [[ -z "$expected" ]]; then
  echo "cargo-deny $version: no pinned binary for this target; installing from source"
  exec cargo install cargo-deny --locked --version "$version"
fi

[[ -n "${RUNNER_TEMP:-}" && -n "${GITHUB_PATH:-}" ]] || fail runner-path-missing
temp_root=$RUNNER_TEMP
github_path=$GITHUB_PATH
windows=false
if [[ "$binary" == *.exe ]]; then
  windows=true
  temp_root=$(cygpath -u "$temp_root")
  github_path=$(cygpath -u "$github_path")
fi
directory=$(mktemp -d "$temp_root/cargo-deny-bin-XXXXXX")
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
url="https://github.com/EmbarkStudios/cargo-deny/releases/download/$version/$asset"
curl --fail --location --silent --show-error --connect-timeout 10 --max-time 60 --output "$directory/$asset" "$url" || fail download-failed
if command -v sha256sum >/dev/null 2>&1; then
  observed=$(sha256sum "$directory/$asset")
else
  observed=$(shasum -a 256 "$directory/$asset")
fi
[[ "${observed%% *}" == "$expected" ]] || fail checksum-mismatch
# Extract only the executable after the complete archive has passed its digest check.
tar -xzOf "$directory/$asset" "$stem/$binary" > "$directory/$binary" || fail extraction-failed
[[ -s "$directory/$binary" ]] || fail extraction-failed
chmod 700 "$directory/$binary"
unlink "$directory/$asset"
observed=$("$directory/$binary" --version) || fail version-mismatch
observed=${observed%$'\r'}
[[ "$observed" == "cargo-deny $version" ]] || fail version-mismatch
export_directory=$directory
if [[ "$windows" == true ]]; then export_directory=$(cygpath -w "$directory"); fi
printf '%s\n' "$export_directory" >> "$github_path"
retain=true
echo "cargo-deny $version: installed verified $target binary"
