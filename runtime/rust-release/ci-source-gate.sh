#!/usr/bin/env bash
set -euo pipefail
ci_failure_subject=ci-rust-source-gate
ci_failure_operation=source-gate
ci_failure_script_dir=${BASH_SOURCE[0]%/*}
if [[ "$ci_failure_script_dir" == "${BASH_SOURCE[0]}" ]]; then ci_failure_script_dir=.; fi
source "$ci_failure_script_dir/../diagnostics/failure.sh"
if (( $# < 2 )); then echo 'arguments-missing' >&2; exit 1; fi
for ci_required_argument in "${@:1:2}"; do
  if [[ -z "$ci_required_argument" ]]; then echo 'arguments-missing' >&2; exit 1; fi
done

profile=${1}
authority_path=${2}

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=authority-read
ci_failure_field=authority-path
ci_failure_expected=unavailable
ci_failure_observed=unavailable
test -s "$authority_path"
ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=profile-binding
ci_failure_field=language-profile
ci_failure_expected=unavailable
ci_failure_observed=unavailable
test "$profile" = rust
test "$(jq -er '.language_profile' "$authority_path")" = "$profile"

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=source-binding
ci_failure_field=source-sha
ci_failure_expected=unavailable
ci_failure_observed=unavailable
source_sha=$(jq -er '.source_sha' "$authority_path")
if ! [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then exit 1; fi
ci_failure_expected=malformed-or-protected
if [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then ci_failure_expected=$source_sha; fi
observed_source_sha=$(git rev-parse HEAD)
ci_failure_observed=malformed-or-protected
if [[ "$observed_source_sha" =~ ^[0-9a-f]{40}$ ]]; then ci_failure_observed=$observed_source_sha; fi
test "$observed_source_sha" = "$source_sha"
