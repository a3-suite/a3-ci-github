#!/usr/bin/env bash

# Owners set stage/field and public scalar comparisons; commands and arguments are never dumped.
ci_failure_stage=input-validation
ci_failure_last_confirmed=not-started
ci_failure_write=not-started
ci_failure_field=input
ci_failure_expected=unavailable
ci_failure_observed=unavailable
ci_failure_line=unavailable
ci_failure_native_exit=unavailable
ci_failure_log() {
  local status=$1 line=${2:-unavailable}
  if (( status == 0 )); then return 0; fi
  printf 'ci-failure-diagnostic:{"classification":{"subject":"%s","operation":"%s","stage":"%s","reason":"%s-failed","cause":"unavailable"},"context":{"input":"%s","values":"protected-or-unavailable"},"comparison":{"field":"%s","expected":"%s","observed":"%s"},"evidence-location":{"log":"stderr","artifact":"not-generated"},"execution-state":{"outcome":"failure","exit":%s,"lastConfirmed":"%s","write":"%s","rollback":"unavailable","line":"%s","nativeExit":"%s"},"next-check":{"rule":"%s","input":"%s"}}\n' \
    "$ci_failure_subject" "$ci_failure_operation" "$ci_failure_stage" "$ci_failure_stage" \
    "$ci_failure_field" "$ci_failure_field" "$ci_failure_expected" "$ci_failure_observed" "$status" \
    "$ci_failure_last_confirmed" "$ci_failure_write" "$line" "$ci_failure_native_exit" "$ci_failure_stage" "$ci_failure_field" >&2 || true
  return "$status"
}
trap 'ci_failure_line=$LINENO' ERR
trap 'ci_failure_log "$?" "$ci_failure_line"' EXIT
