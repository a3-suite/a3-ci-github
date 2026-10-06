#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

operation="${1:-}"
asset_directory="${2:-}"
release_tag="${RELEASE_TAG:-}"
repository="${GITHUB_REPOSITORY:-}"
expected_source_sha="${EXPECTED_SOURCE_SHA:-}"
expected_tag_object="${EXPECTED_TAG_OBJECT:-}"
approved_notes="${APPROVED_RELEASE_NOTES:-}"
assets=(
  a3-ci-github-distribution-manifest.json
  fetch-a3-ci-github.mjs
  SHA256SUMS
)

[[ "$operation" == publish || "$operation" == readback ]] \
  || fail "operation must be publish or readback"
[[ "$approved_notes" =~ [^[:space:]] ]] || fail "approved release notes are required for publication"
approved_notes_base64="$(printf '%s' "$approved_notes" | base64 | tr -d '\r\n')"
approved_title_base64="$(printf '%s' "$release_tag" | base64 | tr -d '\r\n')"
[[ "$release_tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "RELEASE_TAG must match vX.Y.Z"
[[ "$repository" =~ ^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]] \
  || fail "GITHUB_REPOSITORY must identify one repository"
repository_owner="${BASH_REMATCH[1]}"
repository_name="${BASH_REMATCH[2]}"
[[ "$expected_source_sha" =~ ^[0-9a-f]{40}$ ]] \
  || fail "EXPECTED_SOURCE_SHA must be a full commit SHA"
[[ "$expected_tag_object" =~ ^[0-9a-f]{40}$ ]] \
  || fail "EXPECTED_TAG_OBJECT must be a full tag object SHA"
[[ -d "$asset_directory" && ! -L "$asset_directory" ]] \
  || fail "asset directory must be a regular directory"
asset_directory="$(cd "$asset_directory" && pwd -P)"
command -v gh >/dev/null 2>&1 || fail "gh is required"

for asset in "${assets[@]}"; do
  [[ -f "$asset_directory/$asset" && ! -L "$asset_directory/$asset" ]] \
    || fail "distribution asset is missing or not regular: $asset"
done
(
  cd "$asset_directory"
  sha256sum --check --strict SHA256SUMS
)

gh_value() {
  local value
  if ! value="$(gh api "$@")"; then
    fail "GitHub API observation failed"
  fi
  printf '%s' "$value"
}

verify_tag_identity() {
  local observed_tag_object observed_tag_type observed_source_sha
  observed_tag_object="$(gh_value "repos/$repository/git/ref/tags/$release_tag" --jq .object.sha)"
  observed_tag_type="$(gh_value "repos/$repository/git/ref/tags/$release_tag" --jq .object.type)"
  [[ "$observed_tag_object" == "$expected_tag_object" && "$observed_tag_type" == tag ]] \
    || fail "remote release tag object changed after preparation"
  observed_source_sha="$(gh_value "repos/$repository/git/tags/$observed_tag_object" --jq .object.sha)"
  [[ "$observed_source_sha" == "$expected_source_sha" ]] \
    || fail "remote release tag source changed after preparation"
  [[ "$(gh_value "repos/$repository/git/tags/$observed_tag_object" --jq .object.type)" == commit ]] \
    || fail "remote release tag does not resolve directly to a commit"
}

release_snapshot() {
  gh_value "$release_endpoint" \
    --jq '.assets[] | [.name, (.id | tostring)] | @tsv' | LC_ALL=C sort
}

validate_snapshot() {
  local snapshot="$1"
  local allow_missing="$2"
  local asset name id matching_ids count
  while IFS=$'\t' read -r name id; do
    [[ -z "$name" ]] && continue
    case "$name" in
      a3-ci-github-distribution-manifest.json|fetch-a3-ci-github.mjs|SHA256SUMS) ;;
      *) fail "GitHub Release contains an unmanaged asset: $name" ;;
    esac
    [[ "$id" =~ ^[1-9][0-9]*$ ]] || fail "Release asset ID is invalid: $name"
  done <<< "$snapshot"
  for asset in "${assets[@]}"; do
    matching_ids="$(printf '%s\n' "$snapshot" | awk -F '\t' -v name="$asset" '$1 == name { print $2 }')"
    count=0
    while IFS= read -r id; do
      [[ -n "$id" ]] && count=$((count + 1))
    done <<< "$matching_ids"
    (( count <= 1 )) || fail "GitHub Release contains duplicate asset names: $asset"
    if [[ "$allow_missing" == false ]]; then
      (( count == 1 )) || fail "GitHub Release asset is missing: $asset"
    fi
  done
}

asset_id_from_snapshot() {
  local snapshot="$1"
  local asset="$2"
  printf '%s\n' "$snapshot" | awk -F '\t' -v name="$asset" '$1 == name { print $2 }'
}

verify_tag_identity
# GraphQL variables are literals interpreted by GitHub, not shell parameters.
# shellcheck disable=SC2016
resolve_release_id() {
  gh_value graphql \
  -F owner="$repository_owner" \
  -F name="$repository_name" \
  -F tag="$release_tag" \
  -f query='query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId}}}' \
  --jq '.data.repository.release.databaseId // empty'
}
release_id="$(resolve_release_id)"
if [[ -z "$release_id" ]]; then
  [[ "$operation" == publish ]] || fail "GitHub Release does not exist: $release_tag"
  gh release create "$release_tag" \
    --repo "$repository" \
    --verify-tag \
    --title "$release_tag" \
    --draft \
    --notes "$approved_notes"
  release_id="$(resolve_release_id)"
fi
[[ "$release_id" =~ ^[1-9][0-9]*$ ]] || fail "GitHub Release ID is invalid"
release_endpoint="repos/$repository/releases/$release_id"

observed_tag="$(gh_value "$release_endpoint" --jq .tag_name)"
observed_release_id="$(gh_value "$release_endpoint" --jq .id)"
[[ "$observed_release_id" == "$release_id" ]] || fail "GitHub Release ID differs from resolved identity"
observed_draft="$(gh_value "$release_endpoint" --jq .draft)"
[[ "$observed_tag" == "$release_tag" && ( "$observed_draft" == false || "$observed_draft" == true ) ]] \
  || fail "GitHub Release identity is invalid"
verify_release_metadata() {
  local expected_draft="$1"
  [[ "$(gh_value "$release_endpoint" --jq .id)" == "$observed_release_id" ]] \
    || fail "GitHub Release identity changed during verification"
  [[ "$(gh_value "$release_endpoint" --jq '.tag_name | @base64')" == "$approved_title_base64" ]] \
    || fail "GitHub Release tag differs from approved tag"
  # Encoding preserves scalar bytes, including trailing LF, across shell substitution.
  [[ "$(gh_value "$release_endpoint" --jq '.body | @base64')" == "$approved_notes_base64" ]] \
    || fail "GitHub Release body differs from approved notes"
  [[ "$(gh_value "$release_endpoint" --jq '.name | @base64')" == "$approved_title_base64" ]] \
    || fail "GitHub Release title differs from approved title"
  [[ "$(gh_value "$release_endpoint" --jq .prerelease)" == false ]] \
    || fail "GitHub Release must not be a prerelease"
  [[ "$(gh_value "$release_endpoint" --jq .draft)" == "$expected_draft" ]] \
    || fail "GitHub Release publication state changed during verification"
}
verify_release_metadata "$observed_draft"
if [[ "$operation" == readback ]]; then
  [[ "$observed_draft" == false ]] || fail "readback requires a published Release"
fi

temporary_root="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/a3-ci-github-release.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

snapshot="$(release_snapshot)"
allow_missing=false
[[ "$operation" == publish && "$observed_draft" == true ]] && allow_missing=true
validate_snapshot "$snapshot" "$allow_missing"
if [[ "$operation" == publish && "$observed_draft" == true ]]; then
  for asset in "${assets[@]}"; do
    asset_id="$(asset_id_from_snapshot "$snapshot" "$asset")"
    if [[ -z "$asset_id" ]]; then
      gh release upload "$release_tag" "$asset_directory/$asset" --repo "$repository"
    fi
  done
  snapshot="$(release_snapshot)"
fi
validated_snapshot="$snapshot"
validate_snapshot "$validated_snapshot" false
for asset in "${assets[@]}"; do
  asset_id="$(asset_id_from_snapshot "$validated_snapshot" "$asset")"
  gh api \
    -H 'Accept: application/octet-stream' \
    "repos/$repository/releases/assets/$asset_id" > "$temporary_root/$asset" \
    || fail "Release asset readback failed: $asset"
  cmp --silent "$asset_directory/$asset" "$temporary_root/$asset" \
    || fail "Release asset readback differs from prepared bytes: $asset"
done

final_snapshot="$(release_snapshot)"
[[ "$final_snapshot" == "$validated_snapshot" ]] \
  || fail "GitHub Release asset identity changed during readback"
verify_tag_identity
verify_release_metadata "$observed_draft"
if [[ "$operation" == publish ]]; then
  if [[ "$observed_draft" == true ]]; then
    gh release edit "$release_tag" --repo "$repository" --draft=false
  fi
  verify_tag_identity
  verify_release_metadata false
fi
printf '%s\n' "{\"schemaVersion\":\"1\",\"kind\":\"a3-ci-github-distribution-publication\",\"releaseTag\":\"$release_tag\",\"assetNames\":[\"a3-ci-github-distribution-manifest.json\",\"fetch-a3-ci-github.mjs\",\"SHA256SUMS\"],\"readbackStatus\":\"verified\",\"operation\":\"$operation\"}"
