import assert from 'node:assert/strict';
import { after, test } from 'node:test';
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
if [[ "$*" == *'--jq .tag_name'* ]]; then
  cat "$state/tag"
  exit 0
fi
if [[ "$*" == *'--jq .draft'* ]]; then
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
      ...extraEnv,
    },
  },
);

// contract_id: contract.ci-selective-distribution.publication
// integration_id: repository-selective-distribution-release
test('distribution Release publication is idempotent and readback rejects changed remote bytes', () => {
  const assetDirectory = prepareAssets();
  const binaryRoot = prepareFakeGh();
  const stateRoot = path.join(temporaryRoot, 'release-state');
  mkdirSync(stateRoot);

  const apiFailure = execute('publish', assetDirectory, binaryRoot, stateRoot, {
    GH_FAIL_ENDPOINT: '/git/ref/tags/',
  });
  assert.equal(apiFailure.status, 1);
  assert.match(apiFailure.stderr, /API observation failed/);
  assert.equal(existsSync(path.join(stateRoot, 'tag')), false);

  const changedTag = execute('publish', assetDirectory, binaryRoot, stateRoot, {
    REMOTE_TAG_OBJECT: 'c'.repeat(40),
  });
  assert.equal(changedTag.status, 1);
  assert.match(changedTag.stderr, /tag object changed/);
  assert.equal(existsSync(path.join(stateRoot, 'tag')), false);

  const snapshotFailure = execute('publish', assetDirectory, binaryRoot, stateRoot, {
    GH_FAIL_ENDPOINT: '@tsv',
  });
  assert.equal(snapshotFailure.status, 1);
  assert.match(snapshotFailure.stderr, /API observation failed/);
  assert.equal(existsSync(path.join(stateRoot, 'uploads')), false);

  const published = execute('publish', assetDirectory, binaryRoot, stateRoot);
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stdout, /"readbackStatus":"verified"/);
  assert.equal(readFileSync(path.join(stateRoot, 'uploads'), 'utf8').trim().split('\n').length, 3);

  const repeated = execute('publish', assetDirectory, binaryRoot, stateRoot);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(readFileSync(path.join(stateRoot, 'uploads'), 'utf8').trim().split('\n').length, 3);

  const readback = execute('readback', assetDirectory, binaryRoot, stateRoot);
  assert.equal(readback.status, 0, readback.stderr);
  assert.match(readback.stdout, /"operation":"readback"/);

  const raced = execute('readback', assetDirectory, binaryRoot, stateRoot, {
    GH_RACE_AFTER_READBACK: 'true',
  });
  assert.equal(raced.status, 1);
  assert.match(raced.stderr, /asset identity changed during readback/);
  rmSync(path.join(stateRoot, 'race'));

  const unmanagedAsset = path.join(stateRoot, 'assets/unmanaged.zip');
  writeFileSync(unmanagedAsset, 'unmanaged\n');
  const unmanaged = execute('readback', assetDirectory, binaryRoot, stateRoot);
  assert.equal(unmanaged.status, 1);
  assert.match(unmanaged.stderr, /unmanaged asset/);
  rmSync(unmanagedAsset);

  writeFileSync(path.join(stateRoot, 'assets/fetch-a3-ci-github.mjs'), 'changed\n');
  const changed = execute('readback', assetDirectory, binaryRoot, stateRoot);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /readback differs from prepared bytes/);
  assert.equal(readFileSync(path.join(assetDirectory, 'fetch-a3-ci-github.mjs'), 'utf8'), 'console.log("fetch");\n');
});
