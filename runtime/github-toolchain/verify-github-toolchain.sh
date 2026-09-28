#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
  echo 'usage: verify-github-toolchain.sh <jq|gh-jq|jq-sha256|gh-jq-sha256>' >&2
  exit 2
fi

mode="$1"
case "$mode" in
  jq|gh-jq|jq-sha256|gh-jq-sha256) ;;
  *)
    echo 'github-toolchain-mode-invalid' >&2
    exit 1
    ;;
esac

verify_version() {
  local command_name="$1"
  local expected="$2"
  local actual="$3"
  [[ -n "$expected" && "$expected" != *'<'* && "$expected" != *'>'* ]] || {
    echo "${command_name}-version-required" >&2
    exit 1
  }
  [[ "$actual" == "$expected" ]] || {
    echo "${command_name}-version-mismatch: expected=$expected actual=$actual" >&2
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
