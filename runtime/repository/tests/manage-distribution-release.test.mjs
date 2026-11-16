import { afterAll as after, test, describe, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
const prepareAssets = (root) => {
  const directory = path.join(root, 'prepared');
  mkdirSync(directory);
  const manifest = Buffer.from('{"kind":"manifest"}\n');
  const cli = Buffer.from('console.log("fetch");\n');
  const skills = Buffer.from('skills zip\n');
  writeFileSync(path.join(directory, 'a3-ci-github-distribution-manifest.json'), manifest);
  writeFileSync(path.join(directory, 'fetch-a3-ci-github.mjs'), cli);
  writeFileSync(path.join(directory, 'SHA256SUMS'), [
    `${sha256(manifest)}  a3-ci-github-distribution-manifest.json`,
    `${sha256(cli)}  fetch-a3-ci-github.mjs`,
    '',
  ].join('\n'));
  writeFileSync(path.join(directory, 'a3-ci-github-skills.zip'), skills);
  writeFileSync(path.join(directory, 'a3-ci-github-skills.zip.sha256'), `${sha256(skills)}  a3-ci-github-skills.zip\n`);
  return directory;
};

const prepareFakeGh = (root) => {
  const binaryRoot = path.join(root, 'bin');
  const fakeGh = path.join(binaryRoot, 'gh');
  mkdirSync(binaryRoot);
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
state="$GH_STATE"
command="$1"
shift
printf '%s\\n' "$command $*" >> "$state/attempts"
if [[ -n "\${GH_FAIL_OPERATION:-}" && "$command $1" == "$GH_FAIL_OPERATION" ]]; then
  printf '%s' private-child-stdout-sentinel
  printf '%s' private-child-stderr-sentinel >&2
  exit 93
fi
if [[ -n "\${GH_FAIL_ENDPOINT:-}" && "$*" == *"$GH_FAIL_ENDPOINT"* ]]; then
  printf '%s' private-child-stdout-sentinel
  printf '%s' private-child-stderr-sentinel >&2
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
  for name in a3-ci-github-distribution-manifest.json fetch-a3-ci-github.mjs SHA256SUMS a3-ci-github-skills.zip a3-ci-github-skills.zip.sha256; do
    test -f "$state/assets/$name" || continue
    case "$name" in
      a3-ci-github-distribution-manifest.json) id=$((101 + offset)) ;;
      fetch-a3-ci-github.mjs) id=$((102 + offset)) ;;
      SHA256SUMS) id=$((103 + offset)) ;;
      a3-ci-github-skills.zip) id=$((104 + offset)) ;;
      a3-ci-github-skills.zip.sha256) id=$((105 + offset)) ;;
    esac
    printf '%s\\t%s\\n' "$name" "$id"
  done
  test -d "$state/assets" && find "$state/assets" -maxdepth 1 -type f -exec basename {} \\; \\
    | while IFS= read -r name; do
        case "$name" in a3-ci-github-distribution-manifest.json|fetch-a3-ci-github.mjs|SHA256SUMS|a3-ci-github-skills.zip|a3-ci-github-skills.zip.sha256) ;; *) printf '%s\\t999\\n' "$name" ;; esac
      done
  exit 0
fi
case "$*" in
  *'/releases/assets/101') name=a3-ci-github-distribution-manifest.json ;;
  *'/releases/assets/102') name=fetch-a3-ci-github.mjs ;;
  *'/releases/assets/103') name=SHA256SUMS ;;
  *'/releases/assets/104') name=a3-ci-github-skills.zip ;;
  *'/releases/assets/105') name=a3-ci-github-skills.zip.sha256 ;;
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

// Counts the provider requests whose recorded command starts with the prefix; 0 when the provider was never called.
const attemptCount = (stateRoot, prefix) => {
  const attempts = path.join(stateRoot, 'attempts');
  if (!existsSync(attempts)) return 0;
  return readFileSync(attempts, 'utf8').trim().split('\n').filter(line => line.startsWith(prefix)).length;
};
const createCount = (stateRoot) => attemptCount(stateRoot, 'release create');
const uploadCount = (stateRoot) => attemptCount(stateRoot, 'release upload');

// Prepares assets, a fake provider and an empty provider state under their own directory.
const scenario = (name) => {
  const root = path.join(temporaryRoot, name);
  mkdirSync(root);
  const stateRoot = path.join(root, 'state');
  mkdirSync(stateRoot);
  const assetDirectory = prepareAssets(root);
  const binaryRoot = prepareFakeGh(root);
  const run = (operation, extraEnv = {}, state = stateRoot) => execute(operation, assetDirectory, binaryRoot, state, extraEnv);
  return { root, stateRoot, assetDirectory, run };
};

const diagnosticRecords = (result) => result.stderr.split('\n').filter(line => line.startsWith('ci-failure-diagnostic:'))
  .map(line => JSON.parse(line.slice('ci-failure-diagnostic:'.length)));
const failedPublications = [
  ['snapshot', { GH_FAIL_ENDPOINT: '@tsv' }],
  ['upload', { GH_FAIL_OPERATION: 'release upload' }],
  ['readback', { GH_FAIL_ENDPOINT: '/releases/assets/' }],
];

describe("contract.ci-selective-distribution.publication", () => {
  describe("repository-selective-distribution-release", () => {
    // contract_id: contract.ci-selective-distribution.publication
    // flow_id: repository-selective-distribution-release
    test('publication rejects unapproved notes, a changed asset, a failed tag observation and a changed remote tag before creating a Release', () => {
      const { stateRoot, assetDirectory, run } = scenario('rejected-before-create');
      const skillsZip = path.join(assetDirectory, 'a3-ci-github-skills.zip');
      const skillsBytes = readFileSync(skillsZip);
      const unapprovedNotes = run('publish', { APPROVED_RELEASE_NOTES: '' });
      writeFileSync(skillsZip, 'tampered\n');
      const changedAsset = run('publish');
      writeFileSync(skillsZip, skillsBytes);
      const rejections = [
        ['unapproved notes', unapprovedNotes, /approved release notes are required/],
        ['changed asset', changedAsset, /computed checksum did NOT match/],
        ['tag observation failure', run('publish', { GH_FAIL_ENDPOINT: '/git/ref/tags/' }), /API observation failed/],
        ['changed remote tag', run('publish', { REMOTE_TAG_OBJECT: 'c'.repeat(40) }), /tag object changed/],
      ];
      for (const [label, result, message] of rejections) {
        expect(result.status, label).toBe(1);
        expect(result.stderr, label).toMatch(message);
      }
      expect(createCount(stateRoot)).toBe(0);
    });

    // contract_id: contract.ci-selective-distribution.publication
    // flow_id: repository-selective-distribution-release
    test('publication rejects notes that differ from an existing Release and keeps its body', () => {
      const { stateRoot, run } = scenario('rejected-notes-mismatch');
      expect(run('publish').status).toBe(0);
      const createsBefore = createCount(stateRoot);
      const wrongNotes = run('publish', { APPROVED_RELEASE_NOTES: 'different' });
      expect(wrongNotes.status).toBe(1);
      expect(wrongNotes.stderr).toMatch(/body differs from approved notes/);
      expect(createCount(stateRoot)).toBe(createsBefore);
      expect(readFileSync(path.join(stateRoot, 'body'), 'utf8')).toBe('approved');
    });

    // contract_id: contract.ci-selective-distribution.publication
    // flow_id: repository-selective-distribution-release
    test('publication failing before finalize leaves the Release a draft that is not published', () => {
      for (const [name, failureEnv] of failedPublications) {
        const { stateRoot, run } = scenario(`failed-before-finalize-${name}`);
        const failed = run('publish', failureEnv);
        expect(failed.status, name).not.toBe(0);
        expect(diagnosticRecords(failed).length, name).toBeGreaterThan(0);
        expect(readFileSync(path.join(stateRoot, 'draft'), 'utf8'), name).toBe('true');
        expect(existsSync(path.join(stateRoot, 'publications')), name).toBe(false);
      }
    });

    // contract_id: contract.ci-selective-distribution.publication
    // flow_id: repository-selective-distribution-release
    test('publication failure diagnostics record the failed stage for upload, readback and finalize', () => {
      for (const [name, failureEnv, expectedStage, status, write] of [
        ['upload', { GH_FAIL_OPERATION: 'release upload' }, 'asset-upload', 93, 'release-assets-may-be-partial'],
        ['readback', { GH_FAIL_ENDPOINT: '/releases/assets/' }, 'asset-readback', 1, 'release-assets-may-be-partial'],
        ['finalize', { GH_FAIL_OPERATION: 'release edit' }, 'release-finalize', 93, 'finalize-result-unknown'],
      ]) {
        const { run } = scenario(`failed-diagnostic-${name}`);
        const failed = run('publish', failureEnv);
        const records = diagnosticRecords(failed);
        expect(failed.status).toBe(status);
        expect(records.length).toBeGreaterThan(0);
        expect(records.some(evidence => evidence.classification.stage === expectedStage && evidence['execution-state'].nativeExit === '93')).toBe(true);
        expect(records.at(-1)['execution-state']).toMatchObject({ exit: status, write });
        expect(failed.stdout + failed.stderr).not.toContain('private-child-');
      }
    });

    // evidence_role: supplemental
    // The finalize-failure draft state, the absent uploads after a failed snapshot, the provider attempt count, the runner temporary files and the uploaded asset count are
    // implementation mechanisms of the publication flow, not observations of a guarantee.
    // contract_id: contract.ci-selective-distribution.publication
    test('failed publication attempts the failing request once, removes runner temporary files and uploads every asset on success', () => {
      for (const [name, failureEnv, prefix] of [
        ['upload', { GH_FAIL_OPERATION: 'release upload' }, 'release upload'],
        ['readback', { GH_FAIL_ENDPOINT: '/releases/assets/' }, 'api -H Accept: application/octet-stream'],
        ['finalize', { GH_FAIL_OPERATION: 'release edit' }, 'release edit'],
      ]) {
        const { stateRoot, run } = scenario(`failed-attempts-${name}`);
        run('publish', failureEnv);
        expect(attemptCount(stateRoot, prefix), name).toBe(1);
        expect(readFileSync(path.join(stateRoot, 'draft'), 'utf8'), name).toBe('true');
        expect(existsSync(path.join(stateRoot, 'publications')), name).toBe(false);
        expect(readdirSync(temporaryRoot).filter(entry => entry.startsWith('a3-ci-github-release.')), name).toEqual([]);
      }
      const snapshot = scenario('failed-snapshot-uploads');
      snapshot.run('publish', { GH_FAIL_ENDPOINT: '@tsv' });
      expect(existsSync(path.join(snapshot.stateRoot, 'uploads'))).toBe(false);
      const { stateRoot, run } = scenario('published-assets');
      expect(run('publish').status).toBe(0);
      expect(readFileSync(path.join(stateRoot, 'uploads'), 'utf8').trim().split('\n').length).toBe(5);
      const observedEndpoints = readFileSync(path.join(stateRoot, 'api-endpoints'), 'utf8');
      expect(observedEndpoints).not.toContain('/releases/tags/');
      expect(observedEndpoints).toContain('/releases/1');
    });

    // contract_id: contract.ci-selective-distribution.publication
    // flow_id: repository-selective-distribution-release
    test('publication creates one published Release and repeated publication uploads nothing', () => {
      const { stateRoot, run } = scenario('published');
      const published = run('publish');
      expect(published.status, published.stderr).toBe(0);
      expect(readFileSync(path.join(stateRoot, 'draft'), 'utf8')).toBe('false');
      expect(readFileSync(path.join(stateRoot, 'publications'), 'utf8').trim()).toBe('published');
      expect(published.stdout).toMatch(/"readbackStatus":"verified"/);
      const uploadsBefore = uploadCount(stateRoot);

      const repeated = run('publish');
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(repeated.stdout).toMatch(/"readbackStatus":"verified"/);
      expect(readFileSync(path.join(stateRoot, 'draft'), 'utf8')).toBe('false');
      expect(readFileSync(path.join(stateRoot, 'publications'), 'utf8').trim()).toBe('published');
      expect(uploadCount(stateRoot)).toBe(uploadsBefore);
    });

    // evidence_role: supplemental
    // The body that the provider holds after a successful publication is an implementation mechanism of the notes handling, not an observation of a guarantee.
    // contract_id: contract.ci-selective-distribution.publication
    test('publication keeps the exact approved notes including a trailing line feed', () => {
      const exact = scenario('exact-lf');
      const exactLf = exact.run('publish', { APPROVED_RELEASE_NOTES: 'approved\n' });
      expect(exactLf.status, exactLf.stderr).toBe(0);
      expect(readFileSync(path.join(exact.stateRoot, 'body'), 'utf8')).toBe('approved\n');
    });

    // contract_id: contract.ci-selective-distribution.publication
    // flow_id: repository-selective-distribution-release
    test('publication rejects a body changed after finalize', () => {
      const changed = scenario('changed-after-publication');
      const changedAfterPublish = changed.run('publish', { GH_CHANGE_AFTER_PUBLISH: 'true' });
      expect(changedAfterPublish.status).toBe(1);
      expect(changedAfterPublish.stderr).toMatch(/body differs from approved notes/);
    });

    // contract_id: contract.ci-selective-distribution.release-readback
    // flow_id: repository-selective-distribution-release
    test('readback accepts the published Release and rejects changed notes, assets and identities', () => {
      const { stateRoot, run } = scenario('readback');
      expect(run('publish').status).toBe(0);

      const readback = run('readback');
      expect(readback.status, readback.stderr).toBe(0);
      expect(readback.stdout).toMatch(/"operation":"readback"/);
      expect(readback.stdout).toMatch(/"readbackStatus":"verified"/);

      writeFileSync(path.join(stateRoot, 'body'), 'approved\n');
      const extraLf = run('readback');
      expect(extraLf.status).toBe(1);
      expect(extraLf.stderr).toMatch(/body differs from approved notes/);
      writeFileSync(path.join(stateRoot, 'body'), 'approved');

      const raced = run('readback', { GH_RACE_AFTER_READBACK: 'true' });
      expect(raced.status).toBe(1);
      expect(raced.stderr).toMatch(/asset identity changed during readback/);
      rmSync(path.join(stateRoot, 'race'));

      const unmanagedAsset = path.join(stateRoot, 'assets/unmanaged.zip');
      writeFileSync(unmanagedAsset, 'unmanaged\n');
      const unmanaged = run('readback');
      expect(unmanaged.status).toBe(1);
      expect(unmanaged.stderr).toMatch(/unmanaged asset/);
      rmSync(unmanagedAsset);

      writeFileSync(path.join(stateRoot, 'assets/fetch-a3-ci-github.mjs'), 'changed\n');
      const changed = run('readback');
      expect(changed.status).toBe(1);
      expect(changed.stderr).toMatch(/readback differs from prepared bytes/);
    });

    // evidence_role: supplemental
    // The prepared asset bytes are an input of the publication flow, not an observation of a readback guarantee.
    // contract_id: contract.ci-selective-distribution.release-readback
    test('readback rejecting changed remote bytes leaves the prepared assets unchanged', () => {
      const { stateRoot, assetDirectory, run } = scenario('readback-prepared');
      expect(run('publish').status).toBe(0);
      writeFileSync(path.join(stateRoot, 'assets/fetch-a3-ci-github.mjs'), 'changed\n');
      expect(run('readback').status).toBe(1);
      expect(readFileSync(path.join(assetDirectory, 'fetch-a3-ci-github.mjs'), 'utf8')).toBe('console.log("fetch");\n');
    });
  });
});
