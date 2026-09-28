#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

profile=${1:?language profile is required}
platform_manifest=${2:?platform manifest is required}
toolchain=${3:?toolchain is required}
platform_id=${4:?platform id is required}
platform_target=${5:?platform target is required}
authority_path=${6:?authority path is required}
output_dir=${7:?output directory is required}

manifest_path=${CI_CARGO_MANIFEST_PATH:?CI_CARGO_MANIFEST_PATH is required}
binary_name=${CI_RELEASE_BINARY_NAME:?CI_RELEASE_BINARY_NAME is required}
asset_prefix=${CI_RELEASE_ASSET_PREFIX:?CI_RELEASE_ASSET_PREFIX is required}

test "$profile" = rust
test -s "$platform_manifest"
test -s "$manifest_path"
test -s "$authority_path"
test ! -e "$output_dir"
test "$(jq -er '.language_profile' "$authority_path")" = "$profile"
test "$(jq -er '.toolchain_version' "$authority_path")" = "$toolchain"
test "$(jq -er '.platform_manifest' "$authority_path")" = "$platform_manifest"
if ! [[ "$toolchain" =~ ^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$ ]]; then exit 1; fi
source_sha=$(jq -er '.source_sha' "$authority_path")
test "$(git rev-parse HEAD)" = "$source_sha"
if ! [[ "$platform_id" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then exit 1; fi
if ! [[ "$platform_target" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; then exit 1; fi
if ! [[ "$binary_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then exit 1; fi
if ! [[ "$asset_prefix" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then exit 1; fi
case "$(uname -s)" in
  Linux) if [[ "$platform_target" != *-linux-* ]]; then exit 1; fi ;;
  Darwin) if [[ "$platform_target" != *-apple-darwin ]]; then exit 1; fi ;;
  MINGW*|MSYS*|CYGWIN*) if [[ "$platform_target" != *-windows-* ]]; then exit 1; fi ;;
  *) exit 1 ;;
esac

expected_manifest_digest=$(jq -er '.platform_manifest_sha256' "$authority_path")
if ! [[ "$expected_manifest_digest" =~ ^[0-9a-f]{64}$ ]]; then exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then
  actual_manifest_digest=$(tr -d '\r' < "$platform_manifest" | sha256sum | awk '{print $1}')
else
  actual_manifest_digest=$(tr -d '\r' < "$platform_manifest" | shasum -a 256 | awk '{print $1}')
fi
test "$actual_manifest_digest" = "$expected_manifest_digest"
node "$script_dir/dist/index.mjs" \
  "$platform_manifest" "$platform_id" "$platform_target"

if [[ "$platform_target" == *-windows-* ]]; then
  command -v pwsh >/dev/null 2>&1
  pwsh -NoLogo -NoProfile -File "$script_dir/ci-release-build.ps1" \
    -Profile "$profile" \
    -PlatformManifest "$platform_manifest" \
    -Toolchain "$toolchain" \
    -PlatformId "$platform_id" \
    -PlatformTarget "$platform_target" \
    -AuthorityPath "$authority_path" \
    -OutputDirectory "$output_dir"
  exit
fi

rustup toolchain install "$toolchain" --profile minimal
metadata=$(cargo "+$toolchain" metadata --manifest-path "$manifest_path" --locked --no-deps --format-version 1)
version=$(jq -er '.version' "$authority_path")
package_version=$(jq -er --arg manifest "$(cd "$(dirname "$manifest_path")" && pwd)/$(basename "$manifest_path")" \
  '.packages[] | select(.manifest_path == $manifest) | .version' <<<"$metadata")
test "$package_version" = "$version"

rustup target add --toolchain "$toolchain" "$platform_target"
cargo "+$toolchain" build --manifest-path "$manifest_path" --locked --release --target "$platform_target" --bin "$binary_name"
target_directory=$(jq -er '.target_directory' <<<"$metadata")
binary_path="$target_directory/$platform_target/release/$binary_name"
test -x "$binary_path"

version_stderr_file=$(mktemp "${TMPDIR:-/tmp}/ci-release-version.XXXXXX")
cleanup_version_stderr() {
  if [[ -n "${version_stderr_file:-}" ]]; then unlink "$version_stderr_file" 2>/dev/null || true; fi
}
trap cleanup_version_stderr EXIT

binary_version_exit=0
binary_version_stdout=$("$binary_path" --version 2>"$version_stderr_file") || binary_version_exit=$?
binary_version_stderr=$(cat "$version_stderr_file" 2>/dev/null || true)
binary_version_output="${binary_version_stdout}
${binary_version_stderr}"

version_token_present() {
  local output=$1 expected=$2 token
  output=${output//$'\r'/ }
  ( set -f
    for token in $output; do
      if [[ "$token" == "$expected" || "$token" == "v$expected" || "$token" == "V$expected" ]]; then exit 0; fi
    done
    exit 1 )
}
if (( binary_version_exit != 0 )) || ! version_token_present "$binary_version_output" "$version"; then
  printf 'binary-version-mismatch: expected=%s or v%s or V%s received=%s\n' \
    "$version" "$version" "$version" "$binary_version_output" >&2
  exit 1
fi

bash "$script_dir/package-release-unix.sh" \
  "$binary_path" "$binary_name" "$asset_prefix" "$version" "$platform_id" \
  "$platform_target" "$source_sha" "$output_dir"
bash "$script_dir/verify-release-asset-unix.sh" \
  "$binary_name" "$asset_prefix" "$version" "$platform_id" \
  "$platform_target" "$source_sha" "$output_dir"
