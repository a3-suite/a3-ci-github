#!/usr/bin/env bash
set -euo pipefail
ci_failure_subject=ci-rust-release-build
ci_failure_operation=package
ci_failure_script_dir=${BASH_SOURCE[0]%/*}
if [[ "$ci_failure_script_dir" == "${BASH_SOURCE[0]}" ]]; then ci_failure_script_dir=.; fi
source "$ci_failure_script_dir/../diagnostics/failure.sh"
if (( $# < 8 )); then echo 'arguments-missing' >&2; exit 1; fi
for ci_required_argument in "${@:1:8}"; do
  if [[ -z "$ci_required_argument" ]]; then echo 'arguments-missing' >&2; exit 1; fi
done
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

binary_path=${1}
binary_name=${2}
asset_prefix=${3}
version=${4}
platform_id=${5}
platform_target=${6}
source_sha=${7}
output_dir=${8}
while [[ "$output_dir" != "/" && "$output_dir" == */ ]]; do
  output_dir=${output_dir%/}
done

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=binary-read
ci_failure_field=release-binary
ci_failure_expected=unavailable
ci_failure_observed=unavailable
test -f "$binary_path"
test ! -e "$output_dir"
if ! [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then exit 1; fi
ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=archive-create
ci_failure_field=release-archive
ci_failure_expected=unavailable
ci_failure_observed=unavailable
mkdir -p "$(dirname "$output_dir")"
archive_name="${asset_prefix}-${version}-${platform_id}.tar.gz"
artifact_names=("$archive_name" "$archive_name.sha256" "asset-manifest.json")
staging_dir=$(mktemp -d "${output_dir}.tmp.XXXXXX")
output_claimed=false
cleanup() {
  for name in "${artifact_names[@]}"; do
    if [[ -e "$staging_dir/$name" ]]; then unlink "$staging_dir/$name"; fi
    if [[ "$output_claimed" == true && -e "$output_dir/$name" ]]; then
      unlink "$output_dir/$name"
    fi
  done
  if [[ -d "$staging_dir" ]]; then rmdir "$staging_dir"; fi
  if [[ "$output_claimed" == true && -d "$output_dir" ]]; then rmdir "$output_dir"; fi
}
ci_failure_write=staging-may-be-partial
trap 'ci_original_exit=$?; cleanup_status=0; cleanup || cleanup_status=$?; if (( cleanup_status == 0 )); then ci_failure_write=owned-staging-and-output-removed; else ci_failure_write=cleanup-incomplete; fi; ci_failure_log "$ci_original_exit" "$ci_failure_line"' EXIT

COPYFILE_DISABLE=1 tar -C "$(dirname "$binary_path")" -czf "$staging_dir/$archive_name" "$binary_name"
if command -v sha256sum >/dev/null 2>&1; then
  archive_digest=$(sha256sum "$staging_dir/$archive_name" | awk '{print $1}')
else
  archive_digest=$(shasum -a 256 "$staging_dir/$archive_name" | awk '{print $1}')
fi
printf '%s  %s\n' "$archive_digest" "$archive_name" > "$staging_dir/$archive_name.sha256"
jq -n \
  --arg source_sha "$source_sha" \
  --arg version "$version" \
  --arg platform_id "$platform_id" \
  --arg platform_target "$platform_target" \
  --arg archive_name "$archive_name" \
  --arg archive_digest "$archive_digest" \
  '{
    schema_version: "1",
    kind: "ci-release-build-manifest",
    source_sha: $source_sha,
    version: $version,
    platform_id: $platform_id,
    platform_target: $platform_target,
    assets: [{
      path: $archive_name,
      sha256: $archive_digest,
      checksum_path: ($archive_name + ".sha256")
    }]
  }' > "$staging_dir/asset-manifest.json"

bash "$script_dir/verify-release-asset-unix.sh" \
  "$binary_name" "$asset_prefix" "$version" "$platform_id" \
  "$platform_target" "$source_sha" "$staging_dir"
ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=output-create
ci_failure_field=output-directory
ci_failure_expected=unavailable
ci_failure_observed=unavailable
if ! mkdir "$output_dir"; then exit 1; fi
output_claimed=true
ci_failure_write=output-may-be-partial
for name in "${artifact_names[@]}"; do
  mv "$staging_dir/$name" "$output_dir/$name"
done
rmdir "$staging_dir"
output_claimed=false
trap - EXIT
