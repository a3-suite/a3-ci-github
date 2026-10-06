#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

release_tag="${RELEASE_TAG:-}"
release_sha="${RELEASE_SHA:-}"
validate_only="${CI_RELEASE_VALIDATE_ONLY:-false}"

[[ "$release_tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "release tag must match vX.Y.Z: $release_tag"
release_major="${BASH_REMATCH[1]}"
release_minor="${BASH_REMATCH[2]}"
release_patch="${BASH_REMATCH[3]}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] \
  || fail "release SHA must be a full lowercase commit SHA"
[[ "$(git rev-parse --is-inside-work-tree 2>/dev/null || true)" == true ]] \
  || fail "release alias update requires a Git work tree"
git remote get-url origin >/dev/null 2>&1 \
  || fail "release alias update requires the origin remote"

major_alias="v$release_major"
minor_alias="v$release_major.$release_minor"
git fetch --force --no-tags origin "refs/tags/$release_tag:refs/tags/$release_tag"
source_sha="$(git rev-parse "${release_tag}^{commit}")"

[[ "$(git cat-file -t "$release_tag")" == tag ]] \
  || fail "release tag must be annotated: $release_tag"
[[ "$source_sha" == "$release_sha" ]] \
  || fail "tag source does not match the GitHub event commit"
repository_version="$(git show "$source_sha:VERSION" 2>/dev/null)" \
  || fail "tagged commit must contain VERSION"
[[ "$repository_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "repository VERSION must be a release SemVer: $repository_version"
[[ "v$repository_version" == "$release_tag" ]] \
  || fail "release tag version does not match repository VERSION: $release_tag != v$repository_version"

git fetch --no-tags origin refs/heads/main
main_sha="$(git rev-parse --verify 'FETCH_HEAD^{commit}')" || fail "cannot resolve fetched main snapshot"
main_tree="$(git rev-parse --verify "$main_sha^{tree}")" || fail "cannot resolve main tree"

integrated_into_main() {
  local target_sha="$1" role="$2" target_tree ancestry_status
  target_tree="$(git rev-parse --verify "$target_sha^{tree}")" || fail "cannot resolve $role tree"
  if git merge-base --is-ancestor "$target_sha" "$main_sha"; then
    echo "Integration evidence: role=$role method=ancestry target=$target_sha target_tree=$target_tree main=$main_sha main_tree=$main_tree"
  else
    ancestry_status=$?
    [[ "$ancestry_status" == 1 ]] || fail "cannot determine $role ancestry"
    [[ "$target_tree" == "$main_tree" ]] || return 1
    echo "Integration evidence: role=$role method=tree-equality target=$target_sha target_tree=$target_tree main=$main_sha main_tree=$main_tree"
  fi
}

if ! integrated_into_main "$source_sha" source; then
  # Only the canonical next-patch hotfix may precede main integration.
  (( release_patch > 0 )) || fail "release tag source is not integrated into main"
  hotfix_ref="refs/heads/hotfix/$repository_version"
  hotfix_sha="$(git ls-remote --refs origin "$hotfix_ref" | awk 'NR == 1 { print $1 }')"
  [[ "$hotfix_sha" == "$source_sha" ]] \
    || fail "release tag source is not integrated into main or the canonical hotfix tip"
  base_version="$release_major.$release_minor.$((release_patch - 1))"
  base_tag="v$base_version"
  git fetch --no-tags origin "refs/tags/$base_tag:refs/tags/$base_tag"
  [[ "$(git cat-file -t "$base_tag")" == tag ]] || fail "hotfix base tag must be annotated"
  base_sha="$(git rev-parse "${base_tag}^{commit}")"
  [[ "$(git show "$base_sha:VERSION")" == "$base_version" ]] || fail "hotfix base VERSION does not match its tag"
  [[ "$(git show "$main_sha:VERSION")" == "$base_version" ]] || fail "hotfix base is not the current stable main version"
  integrated_into_main "$base_sha" base || fail "hotfix base is not integrated into main"
  git merge-base --is-ancestor "$base_sha" "$source_sha" || fail "hotfix source does not descend from its base"
fi

[[ "$validate_only" == true || "$validate_only" == false ]] \
  || fail "CI_RELEASE_VALIDATE_ONLY must be true or false"
if [[ "$validate_only" == true ]]; then
  echo "Validated release source $release_tag at $source_sha"
  exit 0
fi

git config user.name github-actions[bot]
git config user.email 41898282+github-actions[bot]@users.noreply.github.com

version_is_greater() {
  local left="${1#v}"
  local right="${2#v}"
  local left_major left_minor left_patch
  local right_major right_minor right_patch
  IFS=. read -r left_major left_minor left_patch <<< "$left"
  IFS=. read -r right_major right_minor right_patch <<< "$right"

  if (( 10#$left_major != 10#$right_major )); then
    (( 10#$left_major > 10#$right_major ))
  elif (( 10#$left_minor != 10#$right_minor )); then
    (( 10#$left_minor > 10#$right_minor ))
  else
    (( 10#$left_patch > 10#$right_patch ))
  fi
}

declare -a aliases_to_update=()
observed_major_object=""
observed_minor_object=""
for alias in "$major_alias" "$minor_alias"; do
  remote_object="$(git ls-remote --refs origin "refs/tags/$alias" | awk 'NR == 1 { print $1 }')"
  if [[ "$alias" == "$major_alias" ]]; then
    observed_major_object="$remote_object"
  else
    observed_minor_object="$remote_object"
  fi
  if [[ -z "$remote_object" ]]; then
    aliases_to_update+=("$alias")
    continue
  fi

  git fetch --force --no-tags origin "refs/tags/$alias:refs/tags/$alias"
  [[ "$(git rev-parse "refs/tags/$alias")" == "$remote_object" ]] \
    || fail "alias changed while it was being inspected: $alias"

  current_source="$(git rev-parse "${alias}^{commit}")"
  current_subject="$(git for-each-ref --format='%(contents:subject)' "refs/tags/$alias")"
  alias_subject_regex="^${alias}[[:space:]]->[[:space:]](v[0-9]+\.[0-9]+\.[0-9]+)$"
  if [[ "$current_subject" =~ $alias_subject_regex ]]; then
    current_release="${BASH_REMATCH[1]}"
  else
    current_release="$(git tag --points-at "$current_source" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1 || true)"
  fi

  [[ -n "$current_release" ]] \
    || fail "cannot determine release version for existing alias $alias"
  if version_is_greater "$current_release" "$release_tag"; then
    echo "Keeping $alias at newer release $current_release"
    continue
  fi
  if [[ "$current_release" == "$release_tag" ]]; then
    [[ "$current_source" == "$source_sha" ]] \
      || fail "$alias already maps $release_tag to another commit"
    echo "$alias already points to $release_tag"
    continue
  fi

  aliases_to_update+=("$alias")
done

if (( ${#aliases_to_update[@]} == 0 )); then
  echo "All aliases are already at least as new as $release_tag"
  exit 0
fi

declare -a push_options=()
declare -a alias_refspecs=()
for alias in "${aliases_to_update[@]}"; do
  if [[ "$alias" == "$major_alias" ]]; then
    remote_object="$observed_major_object"
  else
    remote_object="$observed_minor_object"
  fi
  if [[ -n "$remote_object" ]]; then
    push_options+=("--force-with-lease=refs/tags/$alias:$remote_object")
  else
    push_options+=("--force-with-lease=refs/tags/$alias:")
  fi

  git tag -a -f "$alias" "$source_sha" -m "$alias -> $release_tag"
  alias_refspecs+=("refs/tags/$alias")
done

# Immutable full release tags are never included in this mutable alias push.
git push --atomic "${push_options[@]}" origin "${alias_refspecs[@]}"

for alias in "${aliases_to_update[@]}"; do
  remote_object="$(git ls-remote --refs origin "refs/tags/$alias" | awk 'NR == 1 { print $1 }')"
  remote_source="$(git ls-remote origin "refs/tags/${alias}^{}" | awk 'NR == 1 { print $1 }')"
  if [[ -z "$remote_object" || "$remote_object" == "$source_sha" || "$remote_source" != "$source_sha" ]]; then
    fail "remote alias verification failed: $alias"
  fi
done

echo "Updated $major_alias and $minor_alias to $source_sha"
