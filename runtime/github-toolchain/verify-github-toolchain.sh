#!/usr/bin/env bash
set -euo pipefail
ci_failure_subject=ci-github-toolchain-verifier
ci_failure_operation=verify
ci_failure_script_dir=${BASH_SOURCE[0]%/*}
if [[ "$ci_failure_script_dir" == "${BASH_SOURCE[0]}" ]]; then ci_failure_script_dir=.; fi
source "$ci_failure_script_dir/../diagnostics/failure.sh"

if (( $# != 1 )); then
  echo 'usage: verify-github-toolchain.sh <jq|gh-jq|jq-sha256|gh-jq-sha256>' >&2
  exit 2
fi

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=mode-validation
ci_failure_field=mode
ci_failure_expected=unavailable
ci_failure_observed=unavailable
mode="$1"
case "$mode" in
  jq|gh-jq|jq-sha256|gh-jq-sha256) ;;
  *)
    echo 'github-toolchain-mode-invalid' >&2
    exit 1
    ;;
esac

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=tool-version-validation
ci_failure_field=exact-tool-version
ci_failure_expected=unavailable
ci_failure_observed=unavailable
verify_version() {
  local command_name="$1"
  local expected="$2"
  local actual="$3"
  ci_failure_stage=tool-version-validation
  ci_failure_field=${command_name}-version
  ci_failure_expected=unavailable
  ci_failure_observed=unavailable
  ci_failure_expected=malformed-or-protected
  ci_failure_observed=malformed-or-protected
  if [[ "$expected" =~ ^[0-9][0-9.]*$ ]]; then ci_failure_expected=$expected; fi
  if [[ "$actual" =~ ^[0-9][0-9.]*$ ]]; then ci_failure_observed=$actual; fi
  [[ -n "$expected" && "$expected" != *'<'* && "$expected" != *'>'* ]] || {
    echo "${command_name}-version-required" >&2
    exit 1
  }
  [[ "$actual" == "$expected" ]] || {
    echo "${command_name}-version-mismatch: expected=$ci_failure_expected actual=$ci_failure_observed" >&2
    exit 1
  }
}

case "$mode" in
  gh-jq|gh-jq-sha256)
    command -v gh >/dev/null 2>&1 || {
      echo 'github-cli-required' >&2
      exit 1
    }
    gh_version="$(gh --version | awk 'NR == 1 { print $3; exit }')"
    verify_version gh "${CI_GH_VERSION:-}" "$gh_version"
    ;;
esac

ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=jq-availability
ci_failure_field=jq
ci_failure_expected=unavailable
ci_failure_observed=unavailable
command -v jq >/dev/null 2>&1 || {
  echo 'jq-required' >&2
  exit 1
}
jq_version="$(jq --version | sed 's/^jq-//')"
verify_version jq "${CI_JQ_VERSION:-}" "$jq_version"

case "$mode" in
  jq-sha256|gh-jq-sha256)
    command -v sha256sum >/dev/null 2>&1 || {
      echo 'sha256sum-required' >&2
      exit 1
    }
    sha256sum_version="$(sha256sum --version | sed -n '1s/.*) \([0-9][0-9.]*\).*/\1/p')"
    verify_version sha256sum "${CI_SHA256SUM_VERSION:-}" "$sha256sum_version"
    ;;
esac
