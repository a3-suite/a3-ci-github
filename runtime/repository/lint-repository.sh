#!/usr/bin/env bash
set -euo pipefail
ci_failure_subject=repository-managed-source-integrity
ci_failure_operation=repository-lint
ci_failure_script_dir=${BASH_SOURCE[0]%/*}
if [[ "$ci_failure_script_dir" == "${BASH_SOURCE[0]}" ]]; then ci_failure_script_dir=.; fi
source "$ci_failure_script_dir/../diagnostics/failure.sh"

# Repository construction checks only; this script is not a consumer runtime asset.
cd "$(dirname "$0")/../.."
[[ $# == 0 ]] || exit 1
lint_binary="${A3_LINT_BIN:-a3-lint}"
export A3_LINT_BIN="$lint_binary"
lint_profile() {
  local expected_targets="$1"
  shift
  ci_failure_stage=repository-lint
  ci_failure_field=managed-source-lint-profile
  ci_failure_expected=$expected_targets
  ci_failure_observed=unavailable
  "$lint_binary" lint "$@" | node --input-type=module -e '
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const report = JSON.parse(readFileSync(0, "utf8"));
    assert.equal(report.checked_targets, Number(process.argv[1]), "lint must inspect every target");
    assert.deepEqual(report.runtime_errors, []);
    assert.deepEqual(report.diagnostics, []);
    assert.ok(report.trace.execution.some((entry) => entry.kind === "rule_executed"), "lint must execute rules");
    console.log("ok: " + report.checked_targets + " repository lint targets");
  ' "$expected_targets"
}
lint_profile 5 .github/workflows/ci-quality.yml .github/workflows/ci-quality-platforms.yml \
  .github/workflows/ci-package-preparation.yml .github/workflows/ci-release-publication.yml \
  .github/workflows/ci-package-publication.yml --config a3-lint.repository.yaml \
  --lang yaml --framework any --only-rule-set provider-workflows --no-cache
lint_profile 2 .github/workflows/quality-gate.yml .github/workflows/release.yml \
  --config a3-lint.repository.yaml --lang yaml --framework any --only-rule-set repository-workflows --no-cache
shopt -s nullglob
action_metadata=(actions/*/action.yml actions/*/action.yaml)
[[ ${#action_metadata[@]} -gt 0 ]] || exit 1
lint_profile "${#action_metadata[@]}" "${action_metadata[@]}" --config a3-lint.repository.yaml \
  --lang yaml --framework any --only-rule-set repository-actions --no-cache
ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=rule-regression
ci_failure_field=repository-rule-contract
node tests/a3-lint-rule-regression.mjs
ci_failure_last_confirmed=$ci_failure_stage
ci_failure_stage=workflow-contracts
ci_failure_field=workflow-contract-tests
npm test -- tests/workflow-contracts.test.mjs
