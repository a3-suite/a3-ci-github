#!/usr/bin/env bash
set -euo pipefail
ci_failure_subject=ci-rust-release-build
ci_failure_operation=build
ci_failure_script_dir=${BASH_SOURCE[0]%/*}
if [[ "$ci_failure_script_dir" == "${BASH_SOURCE[0]}" ]]; then ci_failure_script_dir=.; fi
source "$ci_failure_script_dir/../diagnostics/failure.sh"
if (( $# < 7 )); then echo 'arguments-missing' >&2; exit 1; fi
for ci_required_argument in "${@:1:7}"; do
  if [[ -z "$ci_required_argument" ]]; then echo 'arguments-missing' >&2; exit 1; fi
done
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

profile=${1}
platform_manifest=${2}
toolchain=${3}
platform_id=${4}
platform_target=${5}
authority_path=${6}
output_dir=${7}

if [[ -z "${CI_CARGO_MANIFEST_PATH:-}" || -z "${CI_RELEASE_BINARY_NAME:-}" || -z "${CI_RELEASE_ASSET_PREFIX:-}" ]]; then
  echo 'rust-release-settings-missing' >&2; exit 1
fi
manifest_path=${CI_CARGO_MANIFEST_PATH}
binary_name=${CI_RELEASE_BINARY_NAME}
asset_prefix=${CI_RELEASE_ASSET_PREFIX}

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=input-validation
ci_failure_field=rust-release-settings
ci_failure_expected=unavailable
ci_failure_observed=unavailable
test "$profile" = rust
test -s "$platform_manifest"
test -s "$manifest_path"
test -s "$authority_path"
test ! -e "$output_dir"
test "$(jq -er '.language_profile' "$authority_path")" = "$profile"
test "$(jq -er '.toolchain_version' "$authority_path")" = "$toolchain"
test "$(jq -er '.platform_manifest' "$authority_path")" = "$platform_manifest"
if ! [[ "$toolchain" =~ ^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$ ]]; then exit 1; fi
ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=source-binding
ci_failure_field=source-sha
ci_failure_expected=unavailable
ci_failure_observed=unavailable
source_sha=$(jq -er '.source_sha' "$authority_path")
ci_failure_expected=malformed-or-protected
if [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then ci_failure_expected=$source_sha; fi
observed_source_sha=$(git rev-parse HEAD)
ci_failure_observed=malformed-or-protected
if [[ "$observed_source_sha" =~ ^[0-9a-f]{40}$ ]]; then ci_failure_observed=$observed_source_sha; fi
test "$observed_source_sha" = "$source_sha"
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

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=platform-binding
ci_failure_field=platform-manifest
ci_failure_expected=unavailable
ci_failure_observed=unavailable
expected_manifest_digest=$(jq -er '.platform_manifest_sha256' "$authority_path")
if ! [[ "$expected_manifest_digest" =~ ^[0-9a-f]{64}$ ]]; then exit 1; fi

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

node "$script_dir/dist/index.mjs" \
  "$platform_manifest" "$platform_id" "$platform_target" "$expected_manifest_digest"

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=toolchain-install
ci_failure_field=rust-toolchain
ci_failure_expected=unavailable
ci_failure_observed=unavailable
rustup toolchain install "$toolchain" --profile minimal --target "$platform_target"
ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=cargo-metadata
ci_failure_field=cargo-manifest
ci_failure_expected=unavailable
ci_failure_observed=unavailable
metadata=$(cargo "+$toolchain" metadata --manifest-path "$manifest_path" --locked --no-deps --format-version 1)
version=$(jq -er '.version' "$authority_path")
package_version=$(jq -er --arg manifest "$(cd "$(dirname "$manifest_path")" && pwd)/$(basename "$manifest_path")" \
  '.packages[] | select(.manifest_path == $manifest) | .version' <<<"$metadata")
ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=package-version-binding
ci_failure_field=package-version
ci_failure_expected=unavailable
ci_failure_observed=unavailable
test "$package_version" = "$version"

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=cargo-build
ci_failure_field=binary-name
ci_failure_expected=unavailable
ci_failure_observed=unavailable
cargo "+$toolchain" build --manifest-path "$manifest_path" --locked --release --target "$platform_target" --bin "$binary_name"
target_directory=$(jq -er '.target_directory' <<<"$metadata")
binary_path="$target_directory/$platform_target/release/$binary_name"
test -x "$binary_path"

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=binary-version-verification
ci_failure_field=binary-version
ci_failure_expected=unavailable
ci_failure_observed=unavailable
version_stderr_file=$(mktemp "${TMPDIR:-/tmp}/ci-release-version.XXXXXX")
cleanup_version_stderr() {
  if [[ -n "${version_stderr_file:-}" ]]; then unlink "$version_stderr_file" 2>/dev/null || true; fi
}
trap 'ci_original_exit=$?; cleanup_version_stderr; ci_failure_log "$ci_original_exit" "$ci_failure_line"' EXIT

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
  ci_failure_expected=malformed-or-protected
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then ci_failure_expected=$version; fi
  ci_failure_observed=version-token-missing-or-process-failed
  printf 'binary-version-mismatch: expected=%s received=protected native-exit=%s\n' "$ci_failure_expected" "$binary_version_exit" >&2
  exit 1
fi

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=asset-package
ci_failure_field=release-archive
ci_failure_expected=unavailable
ci_failure_observed=unavailable
ci_failure_write=output-may-be-partial
bash "$script_dir/package-release-unix.sh" \
  "$binary_path" "$binary_name" "$asset_prefix" "$version" "$platform_id" \
  "$platform_target" "$source_sha" "$output_dir"
ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=asset-verification
ci_failure_field=release-archive
ci_failure_expected=unavailable
ci_failure_observed=unavailable
bash "$script_dir/verify-release-asset-unix.sh" \
  "$binary_name" "$asset_prefix" "$version" "$platform_id" \
  "$platform_target" "$source_sha" "$output_dir"
