#!/usr/bin/env bash
set -euo pipefail
ci_failure_subject=ci-rust-release-build
ci_failure_operation=verify-asset
ci_failure_script_dir=${BASH_SOURCE[0]%/*}
if [[ "$ci_failure_script_dir" == "${BASH_SOURCE[0]}" ]]; then ci_failure_script_dir=.; fi
source "$ci_failure_script_dir/../diagnostics/failure.sh"
if (( $# < 7 )); then echo 'arguments-missing' >&2; exit 1; fi
for ci_required_argument in "${@:1:7}"; do
  if [[ -z "$ci_required_argument" ]]; then echo 'arguments-missing' >&2; exit 1; fi
done

binary_name=${1}
asset_prefix=${2}
version=${3}
platform_id=${4}
platform_target=${5}
source_sha=${6}
output_dir=${7}

archive_name="${asset_prefix}-${version}-${platform_id}.tar.gz"
ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=asset-read
ci_failure_field=release-archive
ci_failure_expected=unavailable
ci_failure_observed=unavailable
test -s "$output_dir/$archive_name"
test -s "$output_dir/$archive_name.sha256"
test -s "$output_dir/asset-manifest.json"
if command -v sha256sum >/dev/null 2>&1; then
  archive_digest=$(sha256sum "$output_dir/$archive_name" | awk '{print $1}')
else
  archive_digest=$(shasum -a 256 "$output_dir/$archive_name" | awk '{print $1}')
fi
printf '%s  %s\n' "$archive_digest" "$archive_name" | cmp -s - "$output_dir/$archive_name.sha256"
test "$(tar -tzf "$output_dir/$archive_name")" = "$binary_name"
jq -e \
  --arg source_sha "$source_sha" \
  --arg version "$version" \
  --arg platform_id "$platform_id" \
  --arg platform_target "$platform_target" \
  --arg archive_name "$archive_name" \
  --arg archive_digest "$archive_digest" \
  'keys == ["assets", "kind", "platform_id", "platform_target", "schema_version", "source_sha", "version"]
    and .schema_version == "1"
    and .kind == "ci-release-build-manifest"
    and .source_sha == $source_sha
    and .version == $version
    and .platform_id == $platform_id
    and .platform_target == $platform_target
    and (.assets | type == "array" and length == 1)
    and (.assets[0] | keys == ["checksum_path", "path", "sha256"])
    and .assets[0].path == $archive_name
    and .assets[0].sha256 == $archive_digest
    and .assets[0].checksum_path == ($archive_name + ".sha256")' \
  "$output_dir/asset-manifest.json" >/dev/null
