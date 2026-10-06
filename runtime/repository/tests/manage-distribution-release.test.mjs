import { afterAll as after, test, describe, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '../../..');
const scriptPath = path.join(repositoryRoot, 'runtime/repository/manage-distribution-release.sh');
const sharedTemporaryRoot = path.join(testRoot, 'tmp');
const sharedTemporaryRootExisted = existsSync(sharedTemporaryRoot);
const temporaryRoot = path.join(sharedTemporaryRoot, `distribution-release-${process.pid}-${Date.now()}`);
mkdirSync(temporaryRoot, { recursive: true });
after(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (!sharedTemporaryRootExisted) {
    try {
      rmdirSync(sharedTemporaryRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
    }
  }
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const expectedSourceSha = 'a'.repeat(40);
const expectedTagObject = 'b'.repeat(40);
const prepareAssets = () => {
  const directory = path.join(temporaryRoot, 'prepared');
  mkdirSync(directory);
  const manifest = Buffer.from('{"kind":"manifest"}\n');
  const cli = Buffer.from('console.log("fetch");\n');
  writeFileSync(path.join(directory, 'a3-ci-github-distribution-manifest.json'), manifest);
  writeFileSync(path.join(directory, 'fetch-a3-ci-github.mjs'), cli);
  writeFileSync(path.join(directory, 'SHA256SUMS'), [
    `${sha256(manifest)}  a3-ci-github-distribution-manifest.json`,
    `${sha256(cli)}  fetch-a3-ci-github.mjs`,
    '',
  ].join('\n'));
  return directory;
};

const prepareFakeGh = () => {
  const binaryRoot = path.join(temporaryRoot, 'bin');
  const fakeGh = path.join(binaryRoot, 'gh');
  mkdirSync(binaryRoot);
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
state="$GH_STATE"
command="$1"
shift
if [[ -n "\${GH_FAIL_ENDPOINT:-}" && "$*" == *"$GH_FAIL_ENDPOINT"* ]]; then
  exit 93
fi
if [[ "$command" == release && "$1" == create ]]; then
  mkdir -p "$state/assets"
  printf '%s\\n' "$2" > "$state/tag"
  shift 2
  draft=false
  while (( $# > 0 )); do
    case "$1" in
      --draft) draft=true; shift ;;
      --title) printf '%s' "$2" > "$state/title"; shift 2 ;;
      --notes) printf '%s' "$2" > "$state/body"; shift 2 ;;
      --repo) shift 2 ;;
      --verify-tag) shift ;;
      *) exit 94 ;;
    esac
  done
  printf '%s' "$draft" > "$state/draft"
  exit 0
fi
if [[ "$command" == release && "$1" == edit ]]; then
  test -f "$state/assets/SHA256SUMS"
  printf false > "$state/draft"
  echo published >> "$state/publications"
  if [[ "\${GH_CHANGE_AFTER_PUBLISH:-}" == true ]]; then
    printf changed > "$state/body"
  fi
  exit 0
fi
if [[ "$command" == release && "$1" == upload ]]; then
  mkdir -p "$state/assets"
  cp -- "$3" "$state/assets/$(basename "$3")"
  echo "$(basename "$3")" >> "$state/uploads"
  exit 0
fi
if [[ "$command" != api ]]; then
  exit 90
fi
printf '%s\\n' "$*" >> "$state/api-endpoints"
if [[ "$1" == *'/releases/tags/'* && -f "$state/draft" && "$(cat "$state/draft")" == true ]]; then
  echo 'gh: Not Found (HTTP 404)' >&2
  exit 1
fi
if [[ "$1" == graphql ]]; then
  test -f "$state/tag" && echo 1
  exit 0
fi
if [[ "$*" == *'/git/ref/tags/'*'--jq .object.sha'* ]]; then
  echo "$REMOTE_TAG_OBJECT"
  exit 0
fi
if [[ "$*" == *'/git/ref/tags/'*'--jq .object.type'* ]]; then
  echo tag
  exit 0
fi
if [[ "$*" == *'/git/tags/'*'--jq .object.sha'* ]]; then
  echo "$REMOTE_SOURCE_SHA"
  exit 0
fi
if [[ "$*" == *'/git/tags/'*'--jq .object.type'* ]]; then
  echo commit
  exit 0
fi
if [[ "$*" == *'@base64'* ]]; then
  case "$*" in
    *'.body | @base64'*) field=body ;;
    *'.name | @base64'*) field=title ;;
    *'.tag_name | @base64'*) field=tag ;;
    *) exit 96 ;;
  esac
  if [[ "$field" == tag ]]; then
    printf '%s' v1.2.3 | base64 | tr -d '\\r\\n'
  else
    base64 < "$state/$field" | tr -d '\\r\\n'
  fi
  exit 0
fi
if [[ "$*" == *'--jq .tag_name'* ]]; then
  cat "$state/tag"
  exit 0
fi
if [[ "$*" == *'--jq .id'* ]]; then
  echo 1
  exit 0
fi
if [[ "$*" == *'--jq .draft'* ]]; then
  cat "$state/draft"
  exit 0
fi
if [[ "$*" == *'--jq .prerelease'* ]]; then
  echo false
  exit 0
fi
if [[ "$*" == *'@tsv'* ]]; then
  offset=0
  test -f "$state/race" && offset=100
  for name in a3-ci-github-distribution-manifest.json fetch-a3-ci-github.mjs SHA256SUMS; do
    test -f "$state/assets/$name" || continue
    case "$name" in
      a3-ci-github-distribution-manifest.json) id=$((101 + offset)) ;;
      fetch-a3-ci-github.mjs) id=$((102 + offset)) ;;
      SHA256SUMS) id=$((103 + offset)) ;;
    esac
    printf '%s\\t%s\\n' "$name" "$id"
  done
  test -d "$state/assets" && find "$state/assets" -maxdepth 1 -type f -exec basename {} \\; \\
    | while IFS= read -r name; do
        case "$name" in a3-ci-github-distribution-manifest.json|fetch-a3-ci-github.mjs|SHA256SUMS) ;; *) printf '%s\\t999\\n' "$name" ;; esac
      done
  exit 0
fi
case "$*" in
  *'/releases/assets/101') name=a3-ci-github-distribution-manifest.json ;;
  *'/releases/assets/102') name=fetch-a3-ci-github.mjs ;;
  *'/releases/assets/103') name=SHA256SUMS ;;
  *) exit 92 ;;
esac
cat "$state/assets/$name"
if [[ "\${GH_RACE_AFTER_READBACK:-}" == true ]]; then
  touch "$state/race"
fi
`);
  chmodSync(fakeGh, 0o755);
  return binaryRoot;
};

const execute = (operation, assetDirectory, binaryRoot, stateRoot, extraEnv = {}) => spawnSync(
  scriptPath,
  [operation, assetDirectory],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binaryRoot}:${process.env.PATH}`,
      GH_STATE: stateRoot,
      GITHUB_REPOSITORY: 'a3-suite/a3-ci-github',
      RELEASE_TAG: 'v1.2.3',
      EXPECTED_SOURCE_SHA: expectedSourceSha,
      EXPECTED_TAG_OBJECT: expectedTagObject,
      REMOTE_SOURCE_SHA: expectedSourceSha,
      REMOTE_TAG_OBJECT: expectedTagObject,
      RUNNER_TEMP: temporaryRoot,
      APPROVED_RELEASE_NOTES: 'approved',
      ...extraEnv,
    },
  },
);

describe("contract.ci-selective-distribution.publication", () => {
  describe("repository-selective-distribution-release", () => {
    // contract_id: contract.ci-selective-distribution.publication
    // integration_id: repository-selective-distribution-release
    test('distribution Release publication is idempotent and readback rejects changed remote bytes', () => {
      const assetDirectory = prepareAssets();
      const binaryRoot = prepareFakeGh();
      const stateRoot = path.join(temporaryRoot, 'release-state');
      mkdirSync(stateRoot);

      const unapproved = execute('publish', assetDirectory, binaryRoot, stateRoot, { APPROVED_RELEASE_NOTES: '' });
      expect(unapproved.status).toBe(1);
      expect(existsSync(path.join(stateRoot, 'tag'))).toBe(false);

      const apiFailure = execute('publish', assetDirectory, binaryRoot, stateRoot, {
        GH_FAIL_ENDPOINT: '/git/ref/tags/',
      });
      expect(apiFailure.status).toBe(1);
      expect(apiFailure.stderr).toMatch(/API observation failed/);
      expect(existsSync(path.join(stateRoot, 'tag'))).toBe(false);

      const changedTag = execute('publish', assetDirectory, binaryRoot, stateRoot, {
        REMOTE_TAG_OBJECT: 'c'.repeat(40),
      });
      expect(changedTag.status).toBe(1);
      expect(changedTag.stderr).toMatch(/tag object changed/);
      expect(existsSync(path.join(stateRoot, 'tag'))).toBe(false);

      const snapshotFailure = execute('publish', assetDirectory, binaryRoot, stateRoot, {
        GH_FAIL_ENDPOINT: '@tsv',
      });
      expect(snapshotFailure.status).toBe(1);
      expect(snapshotFailure.stderr).toMatch(/API observation failed/);
      expect(existsSync(path.join(stateRoot, 'uploads'))).toBe(false);
      expect(readFileSync(path.join(stateRoot, 'draft'), 'utf8')).toBe('true');
      expect(existsSync(path.join(stateRoot, 'publications'))).toBe(false);
      const failedReadback = execute('publish', assetDirectory, binaryRoot, stateRoot, { GH_FAIL_ENDPOINT: '/releases/assets/' });
      expect(failedReadback.status).toBe(1);
      expect(readFileSync(path.join(stateRoot, 'draft'), 'utf8')).toBe('true');
      expect(existsSync(path.join(stateRoot, 'publications'))).toBe(false);

      const published = execute('publish', assetDirectory, binaryRoot, stateRoot);
      expect(published.status, published.stderr).toBe(0);
      expect(readFileSync(path.join(stateRoot, 'draft'), 'utf8')).toBe('false');
      expect(readFileSync(path.join(stateRoot, 'publications'), 'utf8').trim()).toBe('published');
      expect(published.stdout).toMatch(/"readbackStatus":"verified"/);
      expect(readFileSync(path.join(stateRoot, 'uploads'), 'utf8').trim().split('\n').length).toBe(3);
      const observedEndpoints = readFileSync(path.join(stateRoot, 'api-endpoints'), 'utf8');
      expect(observedEndpoints).not.toContain('/releases/tags/');
      expect(observedEndpoints).toContain('/releases/1');

      const repeated = execute('publish', assetDirectory, binaryRoot, stateRoot);
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(readFileSync(path.join(stateRoot, 'publications'), 'utf8').trim()).toBe('published');
      expect(readFileSync(path.join(stateRoot, 'uploads'), 'utf8').trim().split('\n').length).toBe(3);

      const wrongNotes = execute('publish', assetDirectory, binaryRoot, stateRoot, { APPROVED_RELEASE_NOTES: 'different' });
      expect(wrongNotes.status).toBe(1);
      expect(wrongNotes.stderr).toMatch(/body differs from approved notes/);
      expect(readFileSync(path.join(stateRoot, 'body'), 'utf8')).toBe('approved');

      writeFileSync(path.join(stateRoot, 'body'), 'approved\n');
      const extraLf = execute('readback', assetDirectory, binaryRoot, stateRoot);
      expect(extraLf.status).toBe(1);
      expect(extraLf.stderr).toMatch(/body differs from approved notes/);
      writeFileSync(path.join(stateRoot, 'body'), 'approved');
      const lfStateRoot = path.join(temporaryRoot, 'release-with-trailing-lf');
      mkdirSync(lfStateRoot);
      const exactLf = execute('publish', assetDirectory, binaryRoot, lfStateRoot, { APPROVED_RELEASE_NOTES: 'approved\n' });
      expect(exactLf.status, exactLf.stderr).toBe(0);
      expect(readFileSync(path.join(lfStateRoot, 'body'), 'utf8')).toBe('approved\n');

      const changedAfterPublishRoot = path.join(temporaryRoot, 'changed-after-publication');
      mkdirSync(changedAfterPublishRoot);
      const changedAfterPublish = execute('publish', assetDirectory, binaryRoot, changedAfterPublishRoot, { GH_CHANGE_AFTER_PUBLISH: 'true' });
      expect(changedAfterPublish.status).toBe(1);
      expect(changedAfterPublish.stderr).toMatch(/body differs from approved notes/);

      const readback = execute('readback', assetDirectory, binaryRoot, stateRoot);
      expect(readback.status, readback.stderr).toBe(0);
      expect(readback.stdout).toMatch(/"operation":"readback"/);

      const raced = execute('readback', assetDirectory, binaryRoot, stateRoot, {
        GH_RACE_AFTER_READBACK: 'true',
      });
      expect(raced.status).toBe(1);
      expect(raced.stderr).toMatch(/asset identity changed during readback/);
      rmSync(path.join(stateRoot, 'race'));

      const unmanagedAsset = path.join(stateRoot, 'assets/unmanaged.zip');
      writeFileSync(unmanagedAsset, 'unmanaged\n');
      const unmanaged = execute('readback', assetDirectory, binaryRoot, stateRoot);
      expect(unmanaged.status).toBe(1);
      expect(unmanaged.stderr).toMatch(/unmanaged asset/);
      rmSync(unmanagedAsset);

      writeFileSync(path.join(stateRoot, 'assets/fetch-a3-ci-github.mjs'), 'changed\n');
      const changed = execute('readback', assetDirectory, binaryRoot, stateRoot);
      expect(changed.status).toBe(1);
      expect(changed.stderr).toMatch(/readback differs from prepared bytes/);
      expect(readFileSync(path.join(assetDirectory, 'fetch-a3-ci-github.mjs'), 'utf8')).toBe('console.log("fetch");\n');
    });
  });
});
