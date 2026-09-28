#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

binary_path=${1:?binary path is required}
binary_name=${2:?binary name is required}
asset_prefix=${3:?asset prefix is required}
version=${4:?version is required}
platform_id=${5:?platform id is required}
platform_target=${6:?platform target is required}
source_sha=${7:?source SHA is required}
output_dir=${8:?output directory is required}
while [[ "$output_dir" != "/" && "$output_dir" == */ ]]; do
  output_dir=${output_dir%/}
done

test -f "$binary_path"
test ! -e "$output_dir"
if ! [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then exit 1; fi
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
trap cleanup EXIT

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
if ! mkdir "$output_dir"; then exit 1; fi
output_claimed=true
for name in "${artifact_names[@]}"; do
  mv "$staging_dir/$name" "$output_dir/$name"
done
rmdir "$staging_dir"
output_claimed=false
trap - EXIT
