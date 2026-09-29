#!/usr/bin/env bash
set -euo pipefail

profile=${1:?language profile is required}
authority_path=${2:?authority path is required}

test -s "$authority_path"
test "$profile" = rust
test "$(jq -er '.language_profile' "$authority_path")" = "$profile"

source_sha=$(jq -er '.source_sha' "$authority_path")
if ! [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then exit 1; fi
test "$(git rev-parse HEAD)" = "$source_sha"
