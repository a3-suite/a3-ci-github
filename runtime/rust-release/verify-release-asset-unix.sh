#!/usr/bin/env bash
set -euo pipefail

binary_name=${1:?binary name is required}
asset_prefix=${2:?asset prefix is required}
version=${3:?version is required}
platform_id=${4:?platform id is required}
platform_target=${5:?platform target is required}
source_sha=${6:?source SHA is required}
output_dir=${7:?output directory is required}

archive_name="${asset_prefix}-${version}-${platform_id}.tar.gz"
test -s "$output_dir/$archive_name"
test -s "$output_dir/$archive_name.sha256"
test -s "$output_dir/asset-manifest.json"
if command -v sha256sum >/dev/null 2>&1; then
  archive_digest=$(sha256sum "$output_dir/$archive_name" | awk '{print $1}')
else
  archive_digest=$(shasum -a 256 "$output_dir/$archive_name" | awk '{print $1}')
fi
checksum_record=$(<"$output_dir/$archive_name.sha256")
test "$checksum_record" = "$archive_digest  $archive_name"
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
