import fs from 'node:fs';
import path from 'node:path';
import { expect, test, describe } from 'vitest';
import { applyDistributionPlan, fetchDistribution, resolveDistributionSelection, rollbackDistributionTransaction, verifyFetchedDistribution } from '../fetch-a3-ci-github.mjs';
import { snapshotTree } from '../../preset/tests/support/release-request-fixture.mjs';
import { readWorkflowSettings, renderWorkflowTemplate } from '../../preset/workflow-template.mjs';
import { cliApply, cliFetch, cliFetchPeer, cliPlan, cliRollback, cliVerify, createConsumer, fixturePlanSettings, writeManifest, repositoryRoot, yaml, planDistributionApplication, releaseTag, committedSourceRoot, sourceRevision, sha256, withFixture, prepareRelease } from "./selective-distribution.fixtures.mjs";

// Counts the requested assets and the registry-required dependencies that a selection closure lacks.
const closureGapCount = (manifest, requestedPresets, requestedAssets, selectedAssets) => {
  const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const pending = [...requestedAssets, ...requestedPresets.flatMap((id) => manifest.presets.find((preset) => preset.id === id).requiredAssets)];
  const required = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (required.has(id)) continue;
    required.add(id);
    pending.push(...assets.get(id).dependencies);
  }
  return [...required].filter((id) => !selectedAssets.includes(id)).length;
};

const failureOf = (run) => {
  try { run(); } catch (error) { return error; }
  throw new Error('expected the distribution CLI to fail');
};
// The consumer-tree observation leaves out the fetch lock and staging entries that the invocation owns.
const consumerTree = (projectRoot) => Object.fromEntries(Object.entries(snapshotTree(projectRoot))
  .filter(([entry]) => !/(^|[\\/])\.fetch\.lock$/.test(entry) && !/(^|[\\/])\.staging-[^\\/]+([\\/]|$)/.test(entry)));

// Fetches again over a cached distribution that is tampered or locked, with a transport that fails when called.
const rejectCachedState = (root, release, problem) => {
  const projectRoot = createConsumer(root, problem);
  const options = { projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'] };
  const fetched = cliFetch({ ...options, sourceRoot: committedSourceRoot });
  let diagnostic;
  if (problem === 'bytes') {
    fs.appendFileSync(path.join(fetched.distributionRoot, fetched.files[0]), 'tampered');
    diagnostic = 'distribution-local-file-integrity-mismatch';
  } else if (problem === 'receipt') {
    const receiptPath = path.join(fetched.distributionRoot, 'receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.manifestSha256 = '0'.repeat(64);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    diagnostic = 'distribution-local-receipt-invalid';
  } else if (problem === 'manifest') {
    options.manifestPath = path.join(root, 'changed-manifest.json');
    fs.writeFileSync(options.manifestPath, Buffer.concat([release.manifestBytes, Buffer.from('\n')]));
    diagnostic = 'distribution-existing-root-conflict';
  } else {
    fs.writeFileSync(path.join(fetched.distributionRoot, '.fetch.lock'), 'another fetch owns this lock');
    diagnostic = 'distribution-fetch-locked';
  }
  const before = snapshotTree(projectRoot);
  const log = path.join(root, `${problem}-transport.log`);
  const thrown = failureOf(() => cliFetch({ ...options, faults: { transport: { log, failure: 'transport must not be called' } } }));
  return { projectRoot, diagnostic, thrown, before, log };
};

// Extends a verified distribution while the transport fails from the second download on, and starts a peer fetch while the lock is held.
const failExtensionFetch = (root) => {
  const release = prepareRelease(root);
  const projectRoot = createConsumer(root);
  const fetched = cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'],
    sourceRoot: committedSourceRoot });
  const before = snapshotTree(projectRoot);
  const transport = { sourceRoot: committedSourceRoot, sourceRevision };
  const options = { projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'] };
  const lockPath = path.join(fetched.distributionRoot, '.fetch.lock');
  const report = path.join(root, 'probe.jsonl');
  const peerLog = path.join(root, 'peer-transport.log');
  const peer = { call: 1, ...cliFetchPeer({ ...options, faults: { transport: { log: peerLog, failure: 'peer transport must not be called' } } }) };
  const requestLog = path.join(root, 'extension-transport.log');
  const failure = failureOf(() => cliFetch({ ...options, faults: { transport: { ...transport, log: requestLog, failFromCall: 2, probe: { lockPath, report, peer } } } }));
  const probes = fs.readFileSync(report, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n');
  return { release, projectRoot, options, transport, before, lockPath, peerLog, failure, probes, requests };
};

// Fetches again over a cached distribution with a transport that must not be called, while closing or removing the owned lock fails.
const failLockCleanup = (root, release, operation) => {
  const projectRoot = createConsumer(root, operation);
  const options = { projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'] };
  const fetched = cliFetch({ ...options, sourceRoot: committedSourceRoot });
  const lockPath = path.join(fetched.distributionRoot, '.fetch.lock');
  const log = path.join(root, `${operation}-transport.log`);
  const before = consumerTree(projectRoot);
  const faults = { transport: { log, failure: 'transport must not be called' },
    ...(operation === 'close' ? { failClose: [{ path: lockPath }] } : { failRemove: [{ path: lockPath }] }) };
  const failure = failureOf(() => cliFetch({ ...options, faults }));
  return { projectRoot, failure, log, before };
};

// Fetches again with an explicit source root whose bytes differ from the manifest, over a verified distribution.
const rejectInvalidSourceRoot = (root) => {
  const release = prepareRelease(root);
  const projectRoot = createConsumer(root);
  const options = { projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'] };
  const fetched = cliFetch({ ...options, sourceRoot: committedSourceRoot });
  const sourceRoot = path.join(root, 'invalid-source');
  const invalidFile = path.join(sourceRoot, fetched.files[0]);
  fs.mkdirSync(path.dirname(invalidFile), { recursive: true });
  fs.writeFileSync(invalidFile, 'invalid explicit source bytes');
  const before = snapshotTree(projectRoot);
  const log = path.join(root, 'transport.log');
  const thrown = failureOf(() => cliFetch({ ...options, sourceRoot, faults: { transport: { log, failure: 'transport must not be called' } } }));
  return { projectRoot, thrown, before, log };
};

// Fetches with each kind of invalid redirect or transport response over a consumer holding a project-owned file.
const failDownloads = (root) => {
  const release = prepareRelease(root);
  const projectRoot = createConsumer(root);
  fs.writeFileSync(path.join(projectRoot, 'README.md'), 'project-owned content');
  const before = snapshotTree(projectRoot);
  const cases = [
    ['missing Location', { status: 302 }, 'distribution-download-redirect-location-missing'],
    ['untrusted redirect', { status: 302, location: 'https://example.invalid/asset' }, 'distribution-download-redirect-untrusted'],
    ['insecure redirect', { status: 302, location: 'http://raw.githubusercontent.com/asset' }, 'distribution-download-redirect-untrusted'],
    ['HTTP failure', { status: 404 }, 'http-404'],
    ['opaque transport failure', { failure: 'transport unavailable' }, 'network-result-unknown'],
  ];
  const results = cases.map(([label, response, observed], index) => {
    const log = path.join(root, `transport-${index}.log`);
    const failure = failureOf(() => cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'],
      faults: { transport: { log, ...response } } }));
    return { label, failure, observed, requests: fs.readFileSync(log, 'utf8').trim().split('\n'), after: snapshotTree(projectRoot) };
  });
  return { release, projectRoot, before, results };
};

// Applies the quality gate, then returns helpers that rewrite the ownership lock for its workflow.
const prepareOwnedWorkflow = (root) => {
  const release = prepareRelease(root);
  const projectRoot = createConsumer(root);
  const projectDocument = path.join(projectRoot, 'README.md');
  fs.writeFileSync(projectDocument, 'project-owned content');
  cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
  const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
  const initial = cliPlan(options);
  cliApply({ projectRoot, planPath: initial.planPath, approvalDigest: initial.planDigest });
  const workflowPath = '.github/workflows/quality-gate.yml';
  const workflow = path.join(projectRoot, workflowPath);
  const canonical = fs.readFileSync(workflow);
  const lockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
  fs.mkdirSync(path.dirname(lockPath));
  const writeOwnership = (bytes) => fs.writeFileSync(lockPath, JSON.stringify({
    schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision,
    generatedAt: '2026-01-01T00:00:00Z',
    assets: [{ path: workflowPath, canonicalSha256: sha256(canonical), appliedSha256: sha256(bytes) }],
  }));
  writeOwnership(canonical);
  return { projectRoot, projectDocument, options, workflowPath, workflow, canonical, lockPath, writeOwnership };
};

// Rolls back, with the lock removal failing, an apply or rollback of the release-request preset over a fresh consumer.
const failCompletedCleanup = (root, release, operation) => {
  const projectRoot = createConsumer(root, operation);
  cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'], sourceRoot: committedSourceRoot });
  const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['release-request'], requestedAssets: [] });
  const lock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
  const faults = { failRemove: [{ path: lock }] };
  const apply = (options) => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest, ...options });
  const applied = operation === 'rollback' ? apply() : undefined;
  const failure = failureOf(() => (operation === 'apply' ? apply({ faults })
    : cliRollback({ projectRoot, transactionId: applied.transactionId, faults })));
  return { projectRoot, plan, lock, failure };
};

// Rolls back an applied release-request while restoring the last file and recording the transaction both fail.
const failRollbackRecord = (root, release, lockCleanupFails) => {
  const projectRoot = createConsumer(root, String(lockCleanupFails));
  cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'], sourceRoot: committedSourceRoot });
  const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['release-request'], requestedAssets: [] });
  const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
  const transactionPath = path.join(projectRoot, '.a3-skills/ci-github/transactions', applied.transactionId, 'transaction.json');
  const target = path.join(projectRoot, plan.actions.at(-1).destination);
  const before = fs.readFileSync(target);
  const lockPath = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
  const failure = failureOf(() => cliRollback({ projectRoot, transactionId: applied.transactionId, faults: {
    failRemove: [{ path: target }, ...(lockCleanupFails ? [{ path: lockPath }] : [])],
    failRenameAfterRemoveFailure: [{ path: transactionPath }],
  } }));
  return { applied, transactionPath, target, before, lockPath, failure };
};

// Rolls back a transaction that never existed, with the lock removal failing.
const failRollbackCleanup = (projectRoot) => {
  const stateRoot = path.join(projectRoot, '.a3-skills/ci-github');
  fs.mkdirSync(stateRoot, { recursive: true });
  const existing = path.join(projectRoot, 'existing-state');
  fs.writeFileSync(existing, 'preserved\n');
  const transactionId = '1-123456789abc';
  expect(() => cliRollback({ projectRoot, transactionId })).toThrow(/^distribution-transaction-missing$/);
  const lock = path.join(stateRoot, 'apply.lock');
  const failure = failureOf(() => cliRollback({ projectRoot, transactionId, faults: { failRemove: [{ path: lock }] } }));
  return { failure, transactionId, lock, existing };
};

const prepareQualityPlan = (root) => {
  const release = prepareRelease(root);
  const projectRoot = createConsumer(root);
  cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
  const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
  return { projectRoot, options, plan: cliPlan(options) };
};

// Applies a multi-destination plan whose later destination is changed independently after the first destination was written.
const failPartialApply = async (root, { retainLock }) => {
  const release = prepareRelease(root);
  const projectRoot = createConsumer(root);
  cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-publication'], sourceRoot: repositoryRoot });
  const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['release-publication'], requestedAssets: [] });
  expect(plan.actions.length > 1).toBeTruthy();
  const changedPath = path.join(projectRoot, plan.actions[1].destination);
  const retainedLock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
  const failure = failureOf(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest, faults: {
    ...(retainLock ? { failRemove: [{ path: retainedLock }] } : {}),
    transactionHooks: [{ status: 'applying', index: 1, write: { path: changedPath, content: 'changed-after-plan\n' } }],
  } }));
  return { projectRoot, plan, changedPath, retainedLock, failure };
};

// Rolls back a recorded transaction whose workflow, workflow directory or backup changes after rollback has recorded that it is restoring.
const interruptRollback = (scenario, inspect) => withFixture(`distribution-rollback-${scenario}-`, (root) => {
  const projectRoot = path.join(root, 'consumer');
  const transactionId = `1-${'a'.repeat(12)}`;
  const transactionRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions', transactionId);
  const destination = '.github/workflows/quality-gate.yml';
  const workflow = path.join(projectRoot, destination);
  const backup = path.join(transactionRoot, 'before', destination);
  const transactionPath = path.join(transactionRoot, 'transaction.json');
  const externalRoot = path.join(root, 'external-workflows');
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.mkdirSync(externalRoot);
  fs.writeFileSync(workflow, 'applied\n');
  fs.writeFileSync(backup, 'before\n');
  fs.writeFileSync(path.join(externalRoot, 'quality-gate.yml'), 'applied\n');
  fs.writeFileSync(transactionPath, JSON.stringify({
    schemaVersion: '1', kind: 'a3-ci-github-distribution-transaction', transactionId,
    status: 'applied', actions: [{ destination, beforeSha256: sha256('before\n'),
      afterSha256: sha256('applied\n'), state: 'applied' }],
  }));
  // The change lands after rollback has validated its inputs and recorded that it is restoring.
  const change = scenario === 'consumer-edit' ? { write: { path: workflow, content: 'consumer edit\n' } }
    : scenario === 'backup-tamper' ? { write: { path: backup, content: 'tampered backup\n' } }
      : { replaceDirectoryWithSymlink: { directory: path.dirname(workflow), target: externalRoot } };
  const diagnostic = scenario === 'consumer-edit' ? 'distribution-rollback-destination-changed'
    : scenario === 'backup-tamper' ? 'distribution-backup-integrity-mismatch'
      : 'distribution-destination-outside-root';
  const outsideBefore = snapshotTree(externalRoot);
  const thrown = failureOf(() => cliRollback({ projectRoot, transactionId, faults: { transactionHooks: [{ status: 'rolling-back', ...change }] } }));
  inspect({ thrown, diagnostic, workflow, backup, transactionPath, externalRoot, outsideBefore });
});

describe('distribution test fixtures', () => {
  describe('prepareRelease', () => {
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: distribution-fixture-isolation
    test('consumer copies isolate manifest objects and all release bytes from later cases', async () => {
      // Arrange
      await withFixture('distribution-mutated-copy-', async (firstRoot) => {
        const first = prepareRelease(firstRoot);
        const files = (output) => fs.readdirSync(output, { recursive: true })
          .filter((name) => fs.statSync(path.join(output, name)).isFile());
        const bytes = new Map(files(first.output).map((name) => [name, fs.readFileSync(path.join(first.output, name))]));
        // Act
        first.manifest.sourceRevision = 'mutated';
        first.manifestBytes.fill(0);
        for (const name of bytes.keys()) fs.writeFileSync(path.join(first.output, name), 'mutated');
        await withFixture('distribution-clean-copy-', (secondRoot) => {
          const second = prepareRelease(secondRoot);
          // Assert
          expect(second.manifest.sourceRevision).toBe(sourceRevision);
          expect(second.manifest).not.toBe(first.manifest);
          expect(second.manifestBytes).not.toBe(first.manifestBytes);
          expect(second.manifestBytes).toEqual(bytes.get('a3-ci-github-distribution-manifest.json'));
          expect(files(second.output).sort()).toEqual([...bytes.keys()].sort());
          for (const [name, expected] of bytes) expect(fs.readFileSync(path.join(second.output, name))).toEqual(expected);
        });
      });
    });
  });
});



describe("contract.ci-selective-distribution.selection", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.selection
    test('preset closure includes only its reusable workflow sources and excludes optional materializer', async () => {
      await withFixture('a3-ci-github-distribution-source-selection-', (root) => {
        const release = prepareRelease(root);
        const fetchSelection = (name, requestedPresets, requestedAssets) => cliFetch({ projectRoot: createConsumer(root, name),
          manifestPath: release.manifestPath, requestedPresets, requestedAssets, sourceRoot: repositoryRoot });
        const workflowSources = (result) => result.files.filter((source) => source.startsWith('.github/workflows/')).sort();
        const expected = {
          'quality-gate': ['ci-quality.yml'],
          'release-request': [],
          'release-publication': ['ci-release-publication.yml'],
          'package-publication': ['ci-package-preparation.yml', 'ci-package-publication.yml'],
        };
        for (const [preset, workflows] of Object.entries(expected)) {
          const selected = fetchSelection(preset, [preset], []);
          expect(closureGapCount(release.manifest, [preset], [], selected.selectedAssets)).toBe(0);
          expect(selected.selectedAssets).not.toContain('runtime.adapter-materializer');
          expect(workflowSources(selected)).toStrictEqual(workflows.map((file) => `.github/workflows/${file}`).sort());
        }
        expect(() => fetchSelection('platforms-without-runtime', ['quality-gate'], ['workflow.quality-gate-platforms']))
          .toThrow(/^distribution-dependency-missing$/);
        const platforms = fetchSelection('platforms', ['quality-gate'], ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow']);
        expect(closureGapCount(release.manifest, ['quality-gate'], ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow'], platforms.selectedAssets)).toBe(0);
        expect(workflowSources(platforms)).toStrictEqual(['.github/workflows/ci-quality-platforms.yml', '.github/workflows/ci-quality.yml']);
        expect(() => fetchSelection('materializer', [], ['runtime.adapter-materializer'])).toThrow(/^distribution-dependency-missing$/);
      });
    });
  });
});


describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {

    // contract_id: contract.ci-selective-distribution.delivery
    test('manifest validation rejects malformed authority identity files and dependency references', async () => {
      await withFixture('a3-ci-github-distribution-manifest-validation-', (root) => {
        const { manifest } = prepareRelease(root);
        const mutated = (mutate) => {
          const candidate = structuredClone(manifest);
          mutate(candidate);
          return candidate;
        };
        const cases = [
          [null, 'distribution-manifest-invalid'],
          [{ ...manifest, schemaVersion: '1' }, 'distribution-manifest-contract-unsupported'],
          [{ ...manifest, repository: 'other/repository' }, 'distribution-manifest-source-untrusted'],
          [{ ...manifest, sourceRevision: 'main' }, 'distribution-manifest-source-revision-invalid'],
          [{ ...manifest, releaseTag: 'latest' }, 'distribution-manifest-release-tag-invalid'],
          [{ ...manifest, assets: null }, 'distribution-manifest-shape-invalid'],
          [mutated((candidate) => { candidate.reusableWorkflows['.github/workflows/ci-quality.yml'].sourceRevision = 'a'.repeat(40); }), 'distribution-manifest-workflow-binding-invalid'],
          [mutated((candidate) => { candidate.reusableWorkflows['.github/workflows/ci-quality.yml'].referencePlaceholder = '<unknown-workflow-sha>'; }), 'distribution-manifest-workflow-binding-invalid'],
          [mutated((candidate) => { candidate.workflowReferences['quality-workflow-sha'] = 'a'.repeat(40); }), 'distribution-manifest-workflow-binding-invalid'],
          [mutated((candidate) => { candidate.assets.push(structuredClone(candidate.assets[0])); }), 'distribution-manifest-asset-invalid'],
          [mutated((candidate) => { candidate.files[candidate.assets[0].files[0].sourcePath].sha256 = 'invalid'; }), 'distribution-manifest-file-invalid'],
          [mutated((candidate) => { candidate.assets[0].dependencies.push('unknown'); }), 'distribution-dependency-unknown'],
          [mutated((candidate) => { candidate.presets[0].requiredAssets.push('unknown'); }), 'distribution-preset-asset-unknown'],
        ];
        for (const [index, [candidate, diagnostic]] of cases.entries()) {
          const projectRoot = createConsumer(root, `consumer-${index}`);
          const before = snapshotTree(projectRoot);
          expect(() => cliFetch({ projectRoot, manifestPath: writeManifest(root, candidate, `manifest-${index}.json`),
            requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot }), diagnostic).toThrow(new RegExp(`^${diagnostic}$`));
          expect(snapshotTree(projectRoot), diagnostic).toStrictEqual(before);
        }
        const projectRoot = createConsumer(root, 'malformed-json');
        const manifestPath = path.join(root, 'malformed-manifest.json');
        fs.writeFileSync(manifestPath, '{');
        const before = snapshotTree(projectRoot);
        const failure = failureOf(() => cliFetch({ projectRoot, manifestPath, requestedPresets: ['quality-gate'],
          sourceRoot: repositoryRoot }));
        expect(failure.message).toBe('distribution-manifest-invalid');
        expect(failure.evidence.classification.stage).toBe('manifest-validation');
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });

    // contract_id: contract.ci-selective-distribution.delivery
    test('remote manifest loading confines the Release URL and release tag mapping', async () => {
      await withFixture('a3-ci-github-distribution-remote-manifest-', async (root) => {
        const release = prepareRelease(root);
        const faults = { transport: { manifestPath: release.manifestPath, sourceRoot: committedSourceRoot, sourceRevision } };
        const fetchRemote = (name, options) => cliFetch({ projectRoot: createConsumer(root, name), requestedPresets: ['release-request'], faults, ...options });
        const rejectRemote = (name, options, diagnostic) => {
          const projectRoot = createConsumer(root, name);
          const before = snapshotTree(projectRoot);
          expect(() => cliFetch({ projectRoot, requestedPresets: ['release-request'], faults, ...options }), name).toThrow(diagnostic);
          expect(snapshotTree(projectRoot), name).toStrictEqual(before);
        };
        const validUrl = `https://github.com/a3-suite/a3-ci-github/releases/download/${releaseTag}/a3-ci-github-distribution-manifest.json`;
        expect(fetchRemote('valid', { manifestUrl: validUrl }).sourceRevision).toBe(sourceRevision);
        rejectRemote('tag-mismatch', {
          manifestUrl: 'https://github.com/a3-suite/a3-ci-github/releases/download/v9.9.9/a3-ci-github-distribution-manifest.json',
        }, /^distribution-manifest-release-url-mismatch$/);
        rejectRemote('untrusted', { manifestUrl: 'https://example.invalid/manifest.json' }, /^distribution-manifest-url-untrusted$/);
        rejectRemote('exclusive', { manifestPath: release.manifestPath, manifestUrl: validUrl }, /^distribution-manifest-source-exclusive$/);
      });
    });
  });
});


describe("contract.ci-selective-distribution.selection", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.selection
    test('preset selection closes dependencies while direct asset selection reports missing dependencies', async () => {
      await withFixture('a3-ci-github-distribution-selection-', (root) => {
        const release = prepareRelease(root);
        const fetchSelection = (name, requestedPresets, requestedAssets, manifestPath = release.manifestPath) => cliFetch({
          projectRoot: createConsumer(root, name), manifestPath, requestedPresets, requestedAssets, sourceRoot: repositoryRoot });
        const presetAssets = fetchSelection('preset', ['quality-gate'], []).selectedAssets;
        expect(closureGapCount(release.manifest, ['quality-gate'], [], presetAssets)).toBe(0);
        expect(presetAssets).toContain('registry.ci-github');
        expect(presetAssets).toContain('workflow.quality-gate');
        for (const [name, requestedPresets, requestedAssets, diagnostic, comparison] of [
          ['empty', [], [], 'distribution-selection-required'],
          ['unknown-preset', ['unknown'], [], 'distribution-preset-unknown'],
          ['unknown-asset', [], ['unknown'], 'distribution-asset-unknown'],
          ['missing-dependency', [], ['runtime.preset'], 'distribution-dependency-missing',
            { field: 'runtime.preset.dependencies', expected: 'registry.ci-github', observed: 'not-selected' }],
        ]) {
          const projectRoot = createConsumer(root, name);
          const before = snapshotTree(projectRoot);
          const failure = failureOf(() => cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets, requestedAssets, sourceRoot: repositoryRoot }));
          expect(failure.message, name).toBe(diagnostic);
          if (comparison) expect(failure.evidence.comparison, name).toMatchObject(comparison);
          expect(snapshotTree(projectRoot), name).toStrictEqual(before);
        }
        const cyclic = structuredClone(release.manifest);
        cyclic.assets.find((asset) => asset.id === 'registry.ci-github').dependencies.push('runtime.preset');
        expect(() => fetchSelection('cyclic', ['quality-gate'], [], writeManifest(root, cyclic))).toThrow(/^distribution-dependency-cycle$/);
        const direct = fetchSelection('direct', [], ['runtime.preset', 'registry.ci-github', 'runtime.diagnostics']).selectedAssets;
        expect(closureGapCount(release.manifest, [], ['runtime.preset', 'registry.ci-github', 'runtime.diagnostics'], direct)).toBe(0);
        expect(direct).toStrictEqual(['registry.ci-github', 'runtime.diagnostics', 'runtime.preset']);
      });
    });
  });
});


describe("contract.ci-selective-distribution.application", () => {
  describe('provider-pin-companion', () => {
    // contract_id: contract.ci-selective-distribution.application
    test('planned provider pin companions are owned and restored with generated callers', async () => {
      await withFixture('distribution-provider-pins-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const selection = { requestedPresets: ['release-request'], requestedAssets: [] };
        cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, ...selection });
        const options = { projectRoot, sourceRevision, ...selection };
        const plan = cliPlan(options);
        const pins = plan.actions.find((entry) => entry.destination === '.ci/provider-action-pins.yml');
        expect(pins?.action).toBe('create');
        const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        expect(yaml.parse(fs.readFileSync(path.join(projectRoot, pins.destination), 'utf8'))['actions/upload-artifact'].commitSha)
          .toBe(release.manifest.workflowReferences['actions/upload-artifact']);
        expect(cliPlan(options).actions.find((entry) => entry.destination === pins.destination).action).toBe('reuse');
        expect(cliRollback({ projectRoot, transactionId: applied.transactionId }).status).toBe('rolled-back');
        expect(fs.existsSync(path.join(projectRoot, pins.destination))).toBe(false);
        const fresh = cliPlan(options);
        expect(() => cliApply({ projectRoot, planPath: fresh.planPath, approvalDigest: fresh.planDigest,
          faults: { transactionHooks: [{ status: 'applying', destination: pins.destination, throw: true }] } }))
          .toThrow(/^distribution-unknown-failure$/);
        for (const entry of fresh.actions) expect(fs.existsSync(path.join(projectRoot, entry.destination))).toBe(false);
        cliApply({ projectRoot, planPath: fresh.planPath, approvalDigest: fresh.planDigest });
        const pinPath = path.join(projectRoot, pins.destination);
        const priorBytes = `${fs.readFileSync(pinPath, 'utf8')}\n`;
        fs.writeFileSync(pinPath, priorBytes);
        expect(cliPlan(options).actions.find((entry) => entry.destination === pins.destination).action).toBe('conflict');
        fs.writeFileSync(path.join(projectRoot, '.ci/ci-assets.lock.json'), JSON.stringify({
          schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision,
          assets: fresh.actions.map((entry) => ({ path: entry.destination,
            appliedSha256: sha256(fs.readFileSync(path.join(projectRoot, entry.destination))) })),
        }));
        const update = cliPlan(options);
        expect(update.actions.find((entry) => entry.destination === pins.destination).action).toBe('update');
        fs.writeFileSync(pinPath, `${priorBytes}# independent edit\n`);
        expect(() => cliApply({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest }))
          .toThrow(/^distribution-plan-input-changed$/);
        fs.writeFileSync(pinPath, priorBytes);
        const updated = cliApply({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest });
        expect(fs.readFileSync(pinPath, 'utf8')).toBe(pins.generatedContent);
        cliRollback({ projectRoot, transactionId: updated.transactionId });
        expect(fs.readFileSync(pinPath, 'utf8')).toBe(priorBytes);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, requestedPresets: ['quality-gate'] });
        const quality = cliPlan({ ...options, requestedPresets: ['quality-gate'] });
        expect(quality.actions.find((entry) => entry.destination === pins.destination).action).toBe('update');
      });
    });
    // contract_id: contract.ci-selective-distribution.application
    test('owned callers sharing a destination with an unfetched exclusive preset are planned from their own prior template', async () => {
      await withFixture('distribution-shared-destination-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const destination = '.github/workflows/release-publication-caller.yml';
        expect(release.manifest.assets.filter((asset) => asset.files.some((entry) => entry.destination === destination))
          .map((asset) => asset.id)).toEqual(expect.arrayContaining(['workflow.asset-release-publication-caller', 'workflow.release-publication-caller']));
        const selection = { requestedPresets: ['release-publication'], requestedAssets: [] };
        await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          sourceRoot: repositoryRoot, ...selection });
        const options = { projectRoot, sourceRevision, ...selection };
        const plan = planDistributionApplication(options);
        applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        fs.writeFileSync(path.join(projectRoot, '.ci/ci-assets.lock.json'), JSON.stringify({
          schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision,
          assets: plan.actions.map((entry) => ({ path: entry.destination, appliedSha256: entry.generatedSha256 })) }));
        const replanned = planDistributionApplication(options);
        expect(replanned.actions.find((entry) => entry.destination === destination)).toMatchObject(
          { assetId: 'workflow.release-publication-caller', action: 'reuse' });
        expect(replanned.actions.every((entry) => entry.action === 'reuse')).toBe(true);
      });
    });
    // contract_id: contract.ci-selective-distribution.plan
    test('missing prior distributions are classified without treating old schemas as current', async () => {
      await withFixture('distribution-prior-migration-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const selection = { requestedPresets: ['quality-gate'], requestedAssets: [] };
        cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, ...selection });
        const options = { projectRoot, sourceRevision, ...selection };
        const plan = cliPlan(options);
        cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const priorRevision = 'b'.repeat(40);
        const lockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision: priorRevision,
          assets: plan.actions.map((entry) => ({ path: entry.destination, appliedSha256: entry.generatedSha256 })) }));
        const missingBefore = snapshotTree(projectRoot);
        expect(() => cliPlan(options)).toThrow(/^distribution-local-manifest-missing$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(missingBefore);
        const priorRoot = path.join(projectRoot, '.a3-skills/ci-github/distributions', priorRevision);
        fs.mkdirSync(priorRoot);
        fs.writeFileSync(path.join(priorRoot, 'manifest.json'), JSON.stringify({ schemaVersion: '1', kind: release.manifest.kind }));
        fs.writeFileSync(path.join(priorRoot, 'receipt.json'), '{}');
        const unsupportedBefore = snapshotTree(projectRoot);
        expect(() => cliPlan(options)).toThrow(/^distribution-manifest-contract-unsupported$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(unsupportedBefore);
      });
    });
  });
  describe('workflow-template-generation', () => {
    test('normal generation and application need no Hosted evidence and preserve ownership checks', async () => {
      // Arrange
      await withFixture('distribution-template-generation-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
        // Act / Assert
        const workflowPath = path.join(projectRoot, '.github/workflows/quality-gate.yml');
        fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, 'workflows/quality/quality-gate.yml'), workflowPath);
        const independentBytes = fs.readFileSync(workflowPath);
        const unmanaged = cliPlan(options);
        expect(fs.readFileSync(workflowPath)).toEqual(independentBytes);
        expect(unmanaged.actions.map((entry) => entry.action)).toEqual(['conflict']);
        expect(() => cliApply({ projectRoot, planPath: unmanaged.planPath, approvalDigest: unmanaged.planDigest })).toThrow(/^distribution-plan-has-conflicts$/);
        expect(fs.readFileSync(workflowPath, 'utf8')).toContain('<quality-workflow-sha>');
        fs.rmSync(workflowPath);
        const plan = cliPlan(options);
        expect(plan.actions.map((entry) => entry.action)).toStrictEqual(['create']);
        // Consumer files that are neither plan destinations nor distribution state.
        const plannedPaths = plan.actions.map((entry) => entry.destination);
        const unplannedTree = () => Object.fromEntries(Object.entries(snapshotTree(projectRoot)).filter(([entry]) => {
          const key = entry.split(path.sep).join('/').replace(/\/$/, '');
          return !key.startsWith('.a3-skills') && !plannedPaths.some((destination) => destination === key || destination.startsWith(`${key}/`));
        }));
        const unplannedBefore = unplannedTree();
        const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        expect(applied.nextSteps).toEqual(['generate-asset-lock', 'lint', 'preflight', 'consumer-contract-tests']);
        expect(fs.readFileSync(workflowPath, 'utf8')).toBe(plan.actions[0].generatedContent);
        expect(unplannedTree()).toStrictEqual(unplannedBefore);
      });
    });
    // contract_id: contract.ci-selective-distribution.application
    test('workflow generation safely resolves values and preserves only declared caller settings', () => {
      const template = 'on:\n  push:\n    branches: [<protected-branch>]\njobs:\n  quality:\n    uses: provider/workflow@<quality-workflow-sha>\n    with:\n      runner: <versioned-runner>\n      enabled: <feature-enabled>\n      optional: <optional-value>\n';
      const references = { 'quality-workflow-sha': 'a'.repeat(40) };
      const values = { 'protected-branch': ['main', 'develop'], 'versioned-runner': 'ubuntu-24.04\npermissions: write-all', 'feature-enabled': false };
      const rendered = renderWorkflowTemplate({ yaml, template, references, values, emptyAllowed: ['optional-value'] });
      const observed = yaml.parse(rendered);
      expect(observed.jobs.quality.uses).toBe(`provider/workflow@${'a'.repeat(40)}`);
      expect(observed.on.push.branches).toStrictEqual(['main', 'develop']);
      expect(observed.jobs.quality.with.enabled).toBe(false);
      expect(observed.jobs.quality.with.runner).toBe(values['versioned-runner']);
      expect(observed.permissions).toBeUndefined();
      const extracted = readWorkflowSettings({ yaml, template, current: rendered });
      expect(extracted.values['protected-branch']).toStrictEqual(['main', 'develop']);
      expect(extracted.values['versioned-runner']).toBe(values['versioned-runner']);
      expect(extracted.values['quality-workflow-sha']).toBeUndefined();
      expect(() => renderWorkflowTemplate({ yaml, template, references, values: { ...values, unknown: 'x' }, emptyAllowed: ['optional-value'] })).toThrow(/setting-unknown/);
      // A setting carried from the previous template but retired from the new one is dropped instead of blocking the update.
      expect(yaml.parse(renderWorkflowTemplate({ yaml, template, references, values, carriedValues: { 'retired-setting': '', 'feature-enabled': true }, emptyAllowed: ['optional-value'] })).jobs.quality.with.enabled).toBe(false);
      expect(() => renderWorkflowTemplate({ yaml, template, references, values: { ...values, 'feature-enabled': 'false' }, emptyAllowed: ['optional-value'] })).toThrow(/setting-invalid/);
      expect(() => renderWorkflowTemplate({ yaml, template, references, values: {}, emptyAllowed: ['optional-value'] })).toThrow(/setting-missing/);
      const drifted = structuredClone(observed);
      drifted.jobs.quality.permissions = 'write-all';
      expect(() => readWorkflowSettings({ yaml, template, current: yaml.stringify(drifted) })).toThrow(/structure-conflict/);
      expect(renderWorkflowTemplate({ yaml, template, references, values, emptyAllowed: ['optional-value'] })).toBe(rendered);
    });
    // contract_id: contract.ci-selective-distribution.plan
    test('plan rejects unknown and mistyped caller settings and an owned caller with drifted structure', async () => {
      await withFixture('distribution-caller-settings-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
        const settings = fixturePlanSettings(options);
        const before = snapshotTree(projectRoot);
        const withSetting = (key, value) => ({ ...settings, 'workflow.quality-gate': { ...settings['workflow.quality-gate'], [key]: value } });
        expect(() => cliPlan({ ...options, settings: withSetting('unknown-setting', 'x') })).toThrow(/^workflow-template-setting-unknown$/);
        expect(() => cliPlan({ ...options, settings: withSetting('protected-branch', { branch: 'main' }) })).toThrow(/^workflow-template-setting-invalid$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
        const plan = cliPlan(options);
        cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const workflowPath = '.github/workflows/quality-gate.yml';
        const workflow = path.join(projectRoot, workflowPath);
        const drifted = yaml.parse(fs.readFileSync(workflow, 'utf8'));
        drifted.jobs[Object.keys(drifted.jobs)[0]].permissions = 'write-all';
        const driftedBytes = yaml.stringify(drifted);
        fs.writeFileSync(workflow, driftedBytes);
        fs.mkdirSync(path.join(projectRoot, '.ci'), { recursive: true });
        fs.writeFileSync(path.join(projectRoot, '.ci/ci-assets.lock.json'), JSON.stringify({ schemaVersion: '1', kind: 'ci-github-asset-lock',
          sourceRevision, assets: [{ path: workflowPath, appliedSha256: sha256(Buffer.from(driftedBytes)) }] }));
        const ownedBefore = snapshotTree(projectRoot);
        expect(() => cliPlan({ ...options, settings: {} })).toThrow(/^workflow-template-structure-conflict$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(ownedBefore);
      });
    });
    // evidence_role: supplemental
    // The text of a generated workflow (resolved placeholders, the fetched revision, no consumer-local runtime path and the expanded profile matrix) is the content of a plan action, not an observation of a plan, apply or rollback guarantee.
    // contract_id: contract.ci-selective-distribution.application
    test('generated workflows resolve the fetched revision and carry no consumer-local runtime path', async () => {
      await withFixture('distribution-generated-workflows-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        fs.mkdirSync(path.join(projectRoot, '.ci'), { recursive: true });
        fs.writeFileSync(path.join(projectRoot, '.ci/platform-manifest.yml'), 'platforms: [{id: linux-x64, runner: ubuntu-24.04, target: x86_64-unknown-linux-gnu}]\n');
        fs.writeFileSync(path.join(projectRoot, '.ci/quality-platforms.yml'), 'platforms: [{id: linux-x64}]\n');
        const generated = (selection) => {
          const fetched = cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, ...selection });
          const plan = cliPlan({ projectRoot, sourceRevision, ...selection });
          return { fetched, plan, content: Object.fromEntries(plan.actions.map((entry) => [entry.destination, entry.generatedContent])) };
        };
        const quality = generated({ requestedPresets: ['quality-gate'], requestedAssets: [] });
        expect(fs.existsSync(path.join(quality.fetched.distributionRoot, 'runtime/preset/run-validate-ci-preset.mjs'))).toBeTruthy();
        expect(quality.plan.actions.every((entry) => entry.generatedSha256 !== entry.sourceSha256)).toBe(true);
        const qualityWorkflow = quality.content['.github/workflows/quality-gate.yml'];
        expect(qualityWorkflow).toContain(`ci-quality.yml@${sourceRevision}`);
        expect(qualityWorkflow).not.toMatch(/<[a-zA-Z][a-zA-Z0-9._-]*>/);
        expect(qualityWorkflow).not.toMatch(/\.a3-skills\//);
        const optional = generated({ requestedPresets: ['quality-gate'],
          requestedAssets: ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow'] }).content['.github/workflows/quality-gate-platforms.yml'];
        expect(optional).toContain(`uses: a3-suite/a3-ci-github/.github/workflows/ci-quality-platforms.yml@${sourceRevision}`);
        expect(optional).not.toMatch(/ci-platform-matrix@|id: trusted-assets/);
        expect(optional).not.toMatch(/CoreLoader|pyyaml|\.a3-skills\//);
        const profiles = yaml.parse(generated({ requestedPresets: ['quality-gate-profiles'], requestedAssets: [] }).content['.github/workflows/quality-gate-profiles.yml']);
        expect(profiles.jobs.quality.uses).toBe(`a3-suite/a3-ci-github/.github/workflows/ci-quality.yml@${sourceRevision}`);
        expect(profiles.jobs.quality.strategy.matrix.include.map((entry) => entry['language-profile'])).toStrictEqual(['rust', 'python']);
        expect(profiles.jobs['profiles-summary'].name).toBe('quality-gate-profiles / summary');
        const publication = generated({ requestedPresets: ['release-request', 'release-publication'], requestedAssets: [] }).content['.github/workflows/release-publication-caller.yml'];
        expect(publication).toContain(`ci-release-publication.yml@${sourceRevision}`);
        expect(publication).not.toMatch(/\.a3-skills\//);
        const packageCaller = generated({ requestedPresets: ['package-publication'], requestedAssets: [] }).content['.github/workflows/package-publication-caller.yml'];
        expect(packageCaller).toContain(`ci-package-publication.yml@${sourceRevision}`);
      });
    });
    // contract_id: contract.ci-selective-distribution.application
    test('workflow generation expands only a matrix include into profile maps and reads them back', () => {
      const template = 'jobs:\n  quality:\n    strategy:\n      matrix:\n        include: <quality-profiles>\n    with:\n      runner: <versioned-runner>\n      language-profile: ${{ matrix.language-profile }}\n';
      const profiles = [{ 'language-profile': 'rust', 'toolchain-version': '1.90.0' }, { 'language-profile': 'python', 'uv-version': '0.8.0' }];
      const values = { 'quality-profiles': profiles, 'versioned-runner': 'ubuntu-24.04' };
      // Act
      const rendered = renderWorkflowTemplate({ yaml, template, values });
      // Assert
      expect(yaml.parse(rendered).jobs.quality.strategy.matrix.include).toStrictEqual(profiles);
      expect(yaml.parse(rendered).jobs.quality.with['language-profile']).toBe('${{ matrix.language-profile }}');
      expect(readWorkflowSettings({ yaml, template, current: rendered }).values['quality-profiles']).toStrictEqual(profiles);
      expect(yaml.parse(renderWorkflowTemplate({ yaml, template, values: { ...values, 'quality-profiles': [{ 'language-profile': 'rust', 'uv-version': '' }] } })).jobs.quality.strategy.matrix.include)
        .toStrictEqual([{ 'language-profile': 'rust', 'uv-version': '' }]);
      for (const invalid of ['rust', [], [{}], [{ 'language-profile': 1 }], [{ 'Language-Profile': 'rust' }], [{ nested: { a: 'b' } }]]) {
        expect(() => renderWorkflowTemplate({ yaml, template, values: { ...values, 'quality-profiles': invalid } }), JSON.stringify(invalid)).toThrow(/setting-invalid:quality-profiles/);
      }
      const drifted = yaml.parse(rendered);
      drifted.jobs.quality.strategy.matrix.include = [{ 'language-profile': ['rust'] }];
      expect(() => readWorkflowSettings({ yaml, template, current: yaml.stringify(drifted) })).toThrow(/setting-invalid:quality-profiles/);
      expect(() => renderWorkflowTemplate({ yaml, template: template.replace('include: <quality-profiles>', 'other: <quality-profiles>'), values })).toThrow(/setting-invalid:quality-profiles/);
    });
  });
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.delivery
    // contract_id: contract.ci-selective-distribution.application
    test('fetch, plan, apply and rollback preserve explicit consumer state transitions', async () => {
      await withFixture('a3-ci-github-distribution-lifecycle-', async (root) => {
          const release = prepareRelease(root);
          const projectRoot = createConsumer(root);
          const existingFile = path.join(projectRoot, 'README.md');
          fs.writeFileSync(existingFile, 'consumer-owned documentation\n');
          const fetched = cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
          expect(fetched.action).toBe('fetched');
          expect(cliVerify({ projectRoot, sourceRevision }).status).toBe('verified');
          const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] });
          expect(plan.actions.map((entry) => entry.action)).toStrictEqual(['create']);
          const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
          const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
          expect(applied.status).toBe('applied');
          expect(fs.existsSync(workflow)).toBeTruthy();
          expect(applied.nextSteps.includes('preflight')).toBeTruthy();
          expect(applied.nextSteps.includes('materialize-adapters')).toBe(false);
          const ordinaryFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true })
            .filter((entry) => directory !== projectRoot || entry.name !== '.a3-skills')
            .flatMap((entry) => entry.isDirectory()
              ? ordinaryFiles(path.join(directory, entry.name))
              : [path.relative(projectRoot, path.join(directory, entry.name)).split(path.sep).join('/')]);
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.github/workflows/quality-gate.yml', 'README.md']);
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          const rolledBack = cliRollback({ projectRoot, transactionId: applied.transactionId });
          expect(rolledBack.status).toBe('rolled-back');
          expect(rolledBack.rollbackStatus).toBe('restored');
          expect(fs.existsSync(workflow)).toBe(false);
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          const configurations = {
            '.ci/platform-manifest.yml': 'platforms: [{id: linux-x64, runner: ubuntu-24.04, target: x86_64-unknown-linux-gnu}]\n',
            '.ci/quality-platforms.yml': 'platforms: [{id: linux-x64}]\n',
          };
          fs.mkdirSync(path.join(projectRoot, '.ci'), { recursive: true });
          for (const [relative, text] of Object.entries(configurations)) {
            fs.writeFileSync(path.join(projectRoot, relative), text);
          }
          const applySelection = (selection) => {
            cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, ...selection });
            const selectionPlan = cliPlan({ projectRoot, sourceRevision, ...selection });
            return cliApply({ projectRoot, planPath: selectionPlan.planPath, approvalDigest: selectionPlan.planDigest });
          };
          const optionalApplied = applySelection({
            requestedPresets: ['quality-gate'], requestedAssets: ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow'],
          });
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/quality-platforms.yml',
            '.github/workflows/quality-gate-platforms.yml', '.github/workflows/quality-gate.yml', 'README.md',
          ]);
          for (const [relative, text] of Object.entries(configurations)) {
            expect(fs.readFileSync(path.join(projectRoot, relative), 'utf8')).toBe(text);
          }
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          expect(cliRollback({ projectRoot, transactionId: optionalApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
          const profilesApplied = applySelection({ requestedPresets: ['quality-gate-profiles'], requestedAssets: [] });
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/quality-platforms.yml', '.github/workflows/quality-gate-profiles.yml', 'README.md',
          ]);
          expect(cliRollback({ projectRoot, transactionId: profilesApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
          const releaseApplied = applySelection({ requestedPresets: ['release-request', 'release-publication'], requestedAssets: [] });
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/provider-action-pins.yml', '.ci/quality-platforms.yml',
            '.github/workflows/release-publication-caller.yml', '.github/workflows/release-publication-request.yml',
            '.github/workflows/release-request-tag.yml', 'README.md',
          ]);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/release-publication.yml'))).toBe(false);
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          expect(cliRollback({ projectRoot, transactionId: releaseApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
          const packageApplied = applySelection({ requestedPresets: ['package-publication'], requestedAssets: [] });
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/provider-action-pins.yml', '.ci/quality-platforms.yml',
            '.github/workflows/package-publication-caller.yml', '.github/workflows/package-publication-request.yml', 'README.md',
          ]);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/package-publication.yml'))).toBe(false);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/package-preparation.yml'))).toBe(false);
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          expect(cliRollback({ projectRoot, transactionId: packageApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('plan rejects unmanaged destination drift and apply rejects changed plan inputs', async () => {
      await withFixture('a3-ci-github-distribution-conflict-', async (root) => {
          const release = prepareRelease(root);
          const projectRoot = createConsumer(root);
          fs.mkdirSync(path.join(projectRoot, '.github/workflows'), { recursive: true });
          cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
          const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
          const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
          fs.writeFileSync(workflow, 'name: consumer-owned\n');
          const conflict = cliPlan(options);
          expect(conflict.actions.map((entry) => entry.action)).toStrictEqual(['conflict']);
          expect(() => cliApply({ projectRoot, planPath: conflict.planPath, approvalDigest: conflict.planDigest })).toThrow(/^distribution-plan-has-conflicts$/);
          fs.rmSync(workflow);
          const plan = cliPlan(options);
          fs.writeFileSync(workflow, 'name: changed-after-plan\n');
          expect(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest })).toThrow(/^distribution-plan-input-changed$/);
      });
    });
  });
});


describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.delivery
    test('fetch rejects source bytes that do not match the release manifest', async () => {
      await withFixture('a3-ci-github-distribution-integrity-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const before = snapshotTree(projectRoot);
        const manifest = structuredClone(release.manifest);
        manifest.files['workflows/quality/quality-gate.yml'].sha256 = '0'.repeat(64);
        const failure = failureOf(() => cliFetch({
          projectRoot,
          manifestPath: writeManifest(root, manifest),
          requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'],
          sourceRoot: repositoryRoot,
        }));
        expect(failure.message).toBe('distribution-file-integrity-mismatch');
        expect(failure.evidence.comparison.field).toBe('workflows/quality/quality-gate.yml');
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });

    // contract_id: contract.ci-selective-distribution.delivery
    test('fetch rejects a project-local state path redirected through a symlink', async () => {
      await withFixture('a3-ci-github-distribution-symlink-state-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const externalRoot = path.join(root, 'external');
        fs.mkdirSync(externalRoot);
        fs.symlinkSync(externalRoot, path.join(projectRoot, '.a3-skills/ci-github/distributions'));
        const outsideBefore = snapshotTree(externalRoot);
        expect(() => cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot }))
          .toThrow(/^distribution-local-root-outside-project$/);
        expect(snapshotTree(externalRoot)).toStrictEqual(outsideBefore);
      });
    });

    // contract_id: contract.ci-selective-distribution.verification
    test('local verification rejects distribution bytes changed after fetch', async () => {
      await withFixture('a3-ci-github-distribution-local-integrity-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const fetched = cliFetch({
          projectRoot,
          manifestPath: release.manifestPath,
          requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'],
          sourceRoot: repositoryRoot,
        });
        expect(cliVerify({ projectRoot, sourceRevision }).status).toBe('verified');
        fs.writeFileSync(path.join(fetched.distributionRoot, 'workflows/quality/quality-gate.yml'), 'tampered\n');
        const before = snapshotTree(projectRoot);
        expect(() => cliVerify({ projectRoot, sourceRevision })).toThrow(/^distribution-local-file-integrity-mismatch$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });

    // contract_id: contract.ci-selective-distribution.verification
    test('local verification rejects a manifest for a different revision even with a matching receipt digest', async () => {
      await withFixture('distribution-local-revision-', (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const fetched = cliFetch({ projectRoot, manifestPath: release.manifestPath,
          requestedPresets: ['release-request'], sourceRoot: committedSourceRoot });
        const manifestPath = path.join(fetched.distributionRoot, 'manifest.json');
        const receiptPath = path.join(fetched.distributionRoot, 'receipt.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.sourceRevision = (sourceRevision[0] === '0' ? '1' : '0') + sourceRevision.slice(1);
        for (const binding of Object.values(manifest.reusableWorkflows)) {
          binding.sourceRevision = manifest.sourceRevision;
          manifest.workflowReferences[binding.referencePlaceholder.slice(1, -1)] = manifest.sourceRevision;
        }
        const manifestBytes = Buffer.from(JSON.stringify(manifest));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        receipt.manifestSha256 = sha256(manifestBytes);
        fs.writeFileSync(manifestPath, manifestBytes);
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        const before = snapshotTree(projectRoot);

        expect(() => cliVerify({ projectRoot, sourceRevision })).toThrow(/^distribution-local-manifest-revision-mismatch$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });

    // contract_id: contract.ci-selective-distribution.verification
    test('local verification rejects a receipt that omits a file of its selected assets', async () => {
      await withFixture('distribution-local-receipt-file-', (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const fetched = cliFetch({ projectRoot, manifestPath: release.manifestPath,
          requestedPresets: ['release-request'], sourceRoot: committedSourceRoot });
        const receiptPath = path.join(fetched.distributionRoot, 'receipt.json');
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        const [omitted, ...remaining] = receipt.files;
        fs.writeFileSync(path.join(fetched.distributionRoot, omitted), 'tampered\n');
        fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, files: remaining }));
        const before = snapshotTree(projectRoot);

        expect(() => cliVerify({ projectRoot, sourceRevision })).toThrow(/^distribution-local-receipt-files-mismatch$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });
  });
});


describe("contract.ci-selective-distribution.application", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.selection
    // contract_id: contract.ci-selective-distribution.application
    test('direct workflow asset fetch cannot bypass preset closure during apply planning', async () => {
      await withFixture('a3-ci-github-distribution-direct-workflow-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const directAssets = ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'];
        const fetchSelection = (requestedPresets, requestedAssets) => cliFetch({ projectRoot, manifestPath: release.manifestPath,
          requestedPresets, requestedAssets, sourceRoot: repositoryRoot });
        fetchSelection([], directAssets);
        const incompleteBefore = snapshotTree(projectRoot);
        expect(() => cliPlan({ projectRoot, sourceRevision, requestedPresets: [], requestedAssets: directAssets }))
          .toThrow(/^distribution-copy-requires-matching-preset$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(incompleteBefore);
        fetchSelection(['release-request'], []);
        const mismatchedBefore = snapshotTree(projectRoot);
        expect(() => cliPlan({ projectRoot, sourceRevision, requestedPresets: ['release-request'], requestedAssets: directAssets }))
          .toThrow(/^distribution-copy-requires-matching-preset$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(mismatchedBefore);
        const optionalAssets = ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow'];
        fetchSelection(['quality-gate'], optionalAssets);
        const optionalPlan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: optionalAssets });
        expect(optionalPlan.actions.some((entry) => entry.assetId === 'workflow.quality-gate-platforms')).toBeTruthy();
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('apply rechecks destination ancestry immediately before writing', async () => {
      await withFixture('a3-ci-github-distribution-apply-symlink-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const externalRoot = path.join(root, 'external');
        fs.mkdirSync(externalRoot);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] });
        const outsideBefore = snapshotTree(externalRoot);
        expect(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest, faults: { transactionHooks: [{
          status: 'applying', index: 0, replaceDirectoryWithSymlink: { directory: path.join(projectRoot, '.github'), target: externalRoot } }] } }))
          .toThrow(/^distribution-destination-outside-root$/);
        expect(snapshotTree(externalRoot)).toStrictEqual(outsideBefore);
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('partial apply failure restores files changed earlier in the transaction', async () => {
      await withFixture('a3-ci-github-distribution-partial-', async (root) => {
        const { projectRoot, plan, changedPath, failure } = await failPartialApply(root, { retainLock: false });
        expect(failure.message).toBe('distribution-plan-input-changed');
        expect(failure.evidence.classification).toMatchObject({ operation: 'apply', stage: 'destination-recheck' });
        expect(failure.evidence['execution-state']).toMatchObject({ rollback: 'restored' });
        expect(fs.existsSync(path.join(projectRoot, plan.actions[0].destination))).toBe(false);
        expect(fs.readFileSync(changedPath, 'utf8')).toBe('changed-after-plan\n');
        const transactionsRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions');
        const transactionPath = path.join(transactionsRoot, fs.readdirSync(transactionsRoot)[0], 'transaction.json');
        const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
        // Reopens the apply as interrupted, so that its rollback has to leave the independent edit alone.
        transaction.status = 'rollback-required';
        fs.writeFileSync(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
        expect(cliRollback({ projectRoot, transactionId: transaction.transactionId }).status).toBe('rolled-back');
        expect(fs.readFileSync(changedPath, 'utf8')).toBe('changed-after-plan\n');
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test.each(['source', 'manifest', 'plan', 'ownership'])('partial apply restores prior writes when %s changes', async (changedInput) => {
      await withFixture('distribution-apply-input-recheck-', (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const selection = { requestedPresets: ['release-publication'], requestedAssets: [] };
        const fetched = cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, ...selection });
        const plan = cliPlan({ projectRoot, sourceRevision, ...selection });
        expect(plan.actions.length).toBeGreaterThan(1);
        const [file, reason] = {
          source: [path.join(fetched.distributionRoot, plan.actions[1].sourcePath), 'distribution-plan-source-changed'],
          manifest: [path.join(fetched.distributionRoot, 'manifest.json'), 'distribution-plan-manifest-changed'],
          plan: [plan.planPath, 'distribution-plan-approval-invalid'],
          ownership: [path.join(projectRoot, '.ci/ci-assets.lock.json'), 'distribution-plan-ownership-changed'],
        }[changedInput];
        const failure = failureOf(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest,
          faults: { transactionHooks: [{ status: 'applying', index: 1, write: { path: file, content: 'changed-after-first-write\n' } }] } }));
        expect(failure.evidence.classification).toMatchObject({ reason, stage: 'plan-recheck' });
        expect(failure.evidence['execution-state'].rollback).toBe('restored');
        for (const entry of plan.actions) expect(fs.existsSync(path.join(projectRoot, entry.destination))).toBe(false);
        expect(fs.readFileSync(file, 'utf8')).toBe('changed-after-first-write\n');
      });
    });

    // evidence_role: supplemental
    // The retained lock and the transaction record are implementation records of the interrupted apply, not observations of a guarantee.
    test('partial apply failure retains its lock and records which actions were restored', async () => {
      await withFixture('a3-ci-github-distribution-partial-record-', async (root) => {
        const { projectRoot, retainedLock, failure } = await failPartialApply(root, { retainLock: true });
        expect(failure.evidence['execution-state']).toMatchObject({ cleanup: 'lock-cleanup-failed', rollback: 'restored' });
        expect(fs.existsSync(retainedLock)).toBe(true);
        const transactionsRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions');
        const transactionDirectories = fs.readdirSync(transactionsRoot);
        expect(transactionDirectories.length).toBe(1);
        const transaction = JSON.parse(fs.readFileSync(path.join(transactionsRoot, transactionDirectories[0], 'transaction.json'), 'utf8'));
        expect(transaction.status).toBe('rolled-back');
        expect(transaction.actions[0].state).toBe('restored');
        expect(transaction.actions[1].state).toBe('not-applied');
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('application rejects an approval digest that does not match the plan', async () => {
      await withFixture('a3-ci-github-distribution-approval-', async (root) => {
        const { projectRoot, plan } = prepareQualityPlan(root);
        const before = snapshotTree(projectRoot);
        expect(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: '0'.repeat(64) })).toThrow(/^distribution-plan-approval-invalid$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('application writes the approved destinations and preserves unrelated files', async () => {
      await withFixture('distribution-apply-approved-destinations-', (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const selection = { requestedPresets: ['release-publication'], requestedAssets: [] };
        cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, ...selection });
        const plan = cliPlan({ projectRoot, sourceRevision, ...selection });
        fs.writeFileSync(path.join(projectRoot, 'README.md'), 'consumer-owned content\n');
        fs.writeFileSync(path.join(projectRoot, '.a3-skills', 'consumer-note.md'), 'consumer-owned skill notes\n');
        const unrelatedFiles = () => Object.fromEntries(Object.entries(snapshotTree(projectRoot))
          .filter(([entry]) => {
            const relative = entry.split(path.sep).join('/');
            return !relative.endsWith('/') && !relative.startsWith('.a3-skills/ci-github/')
              && !plan.actions.some(({ destination }) => destination === relative);
          }));
        const before = unrelatedFiles();

        const result = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        expect(result).toMatchObject({ planDigest: plan.planDigest, status: 'applied',
          transactionId: expect.stringMatching(/^[0-9]+-[a-f0-9]{12}$/) });
        const recordPath = path.join(projectRoot, '.a3-skills/ci-github/transactions', result.transactionId, 'transaction.json');
        const transaction = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        expect(transaction).toMatchObject({ transactionId: result.transactionId, planDigest: plan.planDigest, status: 'applied' });
        expect(transaction.actions.map(({ destination, beforeSha256 }) => ({ destination, beforeSha256 })))
          .toStrictEqual(plan.actions.map(({ destination, destinationSha256 }) => ({ destination, beforeSha256: destinationSha256 })));
        expect(plan.actions.length).toBeGreaterThan(1);
        for (const entry of plan.actions) {
          expect(sha256(fs.readFileSync(path.join(projectRoot, entry.destination)))).toBe(entry.generatedSha256);
        }
        expect(unrelatedFiles()).toStrictEqual(before);
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('application rejects a planned conflict without modifying consumer files', async () => {
      await withFixture('distribution-apply-planned-conflict-', (root) => {
        const { projectRoot, options, plan } = prepareQualityPlan(root);
        const destination = path.join(projectRoot, plan.actions[0].destination);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, 'consumer-owned content\n');
        const conflict = cliPlan(options);
        const before = snapshotTree(projectRoot);

        expect(() => cliApply({ projectRoot, planPath: conflict.planPath, approvalDigest: conflict.planDigest }))
          .toThrow(/^distribution-plan-has-conflicts$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('application rejects a plan while another mutation holds the mutation lock', async () => {
      await withFixture('a3-ci-github-distribution-mutation-lock-', async (root) => {
        const { projectRoot, plan } = prepareQualityPlan(root);
        fs.writeFileSync(path.join(projectRoot, '.a3-skills/ci-github/apply.lock'), 'occupied\n');
        const before = snapshotTree(projectRoot);
        expect(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest })).toThrow(/^distribution-apply-locked$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('application rejects changed or malformed plan bytes without writing', async () => {
      await withFixture('distribution-apply-approval-', (root) => {
        const { projectRoot, plan } = prepareQualityPlan(root);
        const original = fs.readFileSync(plan.planPath, 'utf8');
        const changed = JSON.parse(original);
        changed.stale.push('.github/workflows/changed.yml');
        for (const bytes of [JSON.stringify(changed), 'null', '{']) {
          fs.writeFileSync(plan.planPath, bytes);
          const before = snapshotTree(projectRoot);
          expect(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }))
            .toThrow(/^distribution-plan-approval-invalid$/);
          expect(snapshotTree(projectRoot)).toStrictEqual(before);
        }
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('application rejects an ownership lock changed after planning', async () => {
      await withFixture('a3-ci-github-distribution-ownership-', async (root) => {
        const { projectRoot, options } = prepareQualityPlan(root);
        const assetLockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
        fs.mkdirSync(path.dirname(assetLockPath), { recursive: true });
        fs.writeFileSync(assetLockPath, '{"schemaVersion":"1","kind":"invalid","assets":[]}\n');
        expect(() => cliPlan(options)).toThrow(/^distribution-prior-asset-lock-invalid$/);
        fs.rmSync(assetLockPath);
        const plan = cliPlan(options);
        fs.writeFileSync(assetLockPath, '{}\n');
        const failure = failureOf(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }));
        expect(failure.message).toBe('distribution-plan-ownership-changed');
        expect(failure.evidence.classification).toMatchObject({ operation: 'apply', stage: 'plan-recheck' });
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('apply rejects a transaction root redirected through a symlink', async () => {
      await withFixture('a3-ci-github-distribution-transaction-root-', async (root) => {
        const { projectRoot, plan } = prepareQualityPlan(root);
        const transactionsPath = path.join(projectRoot, '.a3-skills/ci-github/transactions');
        const externalTransactions = path.join(root, 'external-transactions');
        fs.rmSync(transactionsPath, { recursive: true, force: true });
        fs.mkdirSync(externalTransactions);
        fs.symlinkSync(externalTransactions, transactionsPath);
        const outsideBefore = snapshotTree(externalTransactions);
        expect(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }))
          .toThrow(/^distribution-transaction-root-outside-project$/);
        expect(snapshotTree(externalTransactions)).toStrictEqual(outsideBefore);
      });
    });

    // evidence_role: supplemental
    // The mutation lock is a implementation record: a rejected apply leaves none, and a rollback refuses to start while another mutation holds it.
    test('apply leaves no mutation lock after a redirected transaction root and rollback refuses a held lock', async () => {
      await withFixture('a3-ci-github-distribution-lock-records-', async (root) => {
        const { projectRoot, plan } = prepareQualityPlan(root);
        const mutationLock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
        const transactionsPath = path.join(projectRoot, '.a3-skills/ci-github/transactions');
        const externalTransactions = path.join(root, 'external-transactions');
        fs.rmSync(transactionsPath, { recursive: true, force: true });
        fs.mkdirSync(externalTransactions);
        fs.symlinkSync(externalTransactions, transactionsPath);
        expect(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest })).toThrow(/^distribution-transaction-root-outside-project$/);
        expect(fs.existsSync(mutationLock)).toBe(false);
        fs.rmSync(transactionsPath);
        const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        fs.writeFileSync(mutationLock, 'occupied\n');
        expect(() => cliRollback({ projectRoot, transactionId: applied.transactionId })).toThrow(/^distribution-apply-locked$/);
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('rollback validates every backup identity before changing consumer files', async () => {
      await withFixture('a3-ci-github-distribution-backup-integrity-', (root) => {
        const projectRoot = path.join(root, 'consumer');
        const transactionId = `1-${'a'.repeat(12)}`;
        const transactionRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions', transactionId);
        const first = { destination: '.github/workflows/first.yml', before: 'first-before\n', after: 'first-after\n' };
        const second = { destination: '.github/workflows/second.yml', before: 'second-before\n', after: 'second-after\n' };
        for (const entry of [first, second]) {
          const destination = path.join(projectRoot, entry.destination);
          const backup = path.join(transactionRoot, 'before', entry.destination);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.writeFileSync(destination, entry.after);
          fs.writeFileSync(backup, entry.before);
        }
        fs.writeFileSync(path.join(transactionRoot, 'before', second.destination), 'tampered\n');
        fs.writeFileSync(path.join(transactionRoot, 'transaction.json'), `${JSON.stringify({
          schemaVersion: '1',
          kind: 'a3-ci-github-distribution-transaction',
          transactionId,
          planDigest: 'b'.repeat(64),
          sourceRevision,
          status: 'applied',
          actions: [first, second].map((entry) => ({
            destination: entry.destination,
            beforeSha256: sha256(Buffer.from(entry.before)),
            afterSha256: sha256(Buffer.from(entry.after)),
            state: 'applied',
          })),
        }, null, 2)}\n`);
        expect(() => rollbackDistributionTransaction({ projectRoot, transactionId })).toThrow(/distribution-backup-integrity-mismatch/);
        expect(fs.readFileSync(path.join(projectRoot, first.destination), 'utf8')).toBe(first.after);
        fs.writeFileSync(path.join(transactionRoot, 'before', second.destination), second.before);
        const transactionPath = path.join(transactionRoot, 'transaction.json');
        const interrupted = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
        interrupted.status = 'applying';
        interrupted.actions[0].state = 'restored';
        fs.writeFileSync(path.join(projectRoot, first.destination), first.before);
        fs.writeFileSync(transactionPath, `${JSON.stringify(interrupted, null, 2)}\n`);
        expect(rollbackDistributionTransaction({ projectRoot, transactionId }).status).toBe('rolled-back');
        expect(fs.readFileSync(path.join(projectRoot, second.destination), 'utf8')).toBe(second.before);
      });
    });

    // contract_id: contract.ci-selective-distribution.rollback
    test('rollback removes a destination created by the recorded transaction', async () => {
      await withFixture('distribution-rollback-created-destination-', (root) => {
        const { projectRoot, plan } = prepareQualityPlan(root);
        const destination = path.join(projectRoot, plan.actions[0].destination);
        expect(fs.existsSync(destination)).toBe(false);
        const { transactionId } = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        expect(fs.existsSync(destination)).toBe(true);

        expect(cliRollback({ projectRoot, transactionId }).rollbackStatus).toBe('restored');
        expect(fs.existsSync(destination)).toBe(false);
      });
    });

    // contract_id: contract.ci-selective-distribution.rollback
    test('rollback restores the previous bytes of an updated destination and preserves unrelated files', async () => {
      await withFixture('distribution-rollback-updated-destination-', (root) => {
        const { projectRoot, options, workflow, workflowPath, canonical, writeOwnership } = prepareOwnedWorkflow(root);
        const previous = Buffer.from(canonical.toString('utf8').replaceAll('ubuntu-24.04', 'ubuntu-22.04'));
        expect(previous).not.toEqual(canonical);
        fs.writeFileSync(workflow, previous);
        writeOwnership(previous);
        const plan = cliPlan(options);
        const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        expect(fs.readFileSync(workflow)).toStrictEqual(canonical);
        const ordinaryFiles = () => Object.fromEntries(Object.entries(snapshotTree(projectRoot))
          .filter(([entry]) => {
            const relative = entry.split(path.sep).join('/');
            return relative !== workflowPath && !relative.startsWith('.a3-skills/ci-github/transactions/');
          }));
        const before = ordinaryFiles();

        expect(cliRollback({ projectRoot, transactionId: applied.transactionId })).toMatchObject({
          status: 'rolled-back', rollbackStatus: 'restored',
        });
        expect(fs.readFileSync(workflow)).toStrictEqual(previous);
        expect(ordinaryFiles()).toStrictEqual(before);
      });
    });

    // contract_id: contract.ci-selective-distribution.rollback
    test('rollback refuses to overwrite consumer changes made after apply', async () => {
      await withFixture('a3-ci-github-distribution-rollback-conflict-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] });
        const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
        fs.writeFileSync(workflow, 'name: edited-after-apply\n');
        expect(() => cliRollback({ projectRoot, transactionId: applied.transactionId })).toThrow(/^distribution-rollback-destination-changed$/);
        expect(fs.readFileSync(workflow, 'utf8')).toBe('name: edited-after-apply\n');
      });
      await interruptRollback('consumer-edit', ({ thrown, diagnostic, workflow }) => {
        expect(thrown.message).toBe(diagnostic);
        expect(fs.readFileSync(workflow, 'utf8')).toBe('consumer edit\n');
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('rollback does not write through a destination ancestor redirected by a symlink', async () => {
      await interruptRollback('destination-symlink', ({ thrown, diagnostic, workflow, externalRoot, outsideBefore }) => {
        expect(thrown.message).toBe(diagnostic);
        expect(fs.lstatSync(path.dirname(workflow)).isSymbolicLink()).toBe(true);
        expect(snapshotTree(externalRoot)).toStrictEqual(outsideBefore);
      });
    });

    // evidence_role: supplemental
    // The tampered backup, the untouched workflow and the rollback-required status of the transaction record are implementation records, not observations of a guarantee.
    test('interrupted rollback keeps a tampered backup and records that rollback is required', async () => {
      for (const scenario of ['consumer-edit', 'destination-symlink', 'backup-tamper']) {
        await interruptRollback(scenario, ({ thrown, diagnostic, workflow, backup, transactionPath }) => {
          expect(thrown.message, scenario).toBe(diagnostic);
          if (scenario === 'backup-tamper') {
            expect(fs.readFileSync(backup, 'utf8')).toBe('tampered backup\n');
            expect(fs.readFileSync(workflow, 'utf8')).toBe('applied\n');
          }
          expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).status, scenario).toBe('rollback-required');
        });
      }
    });
  });
});


describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {

    // contract_id: contract.ci-selective-distribution.delivery
    test('same revision merges separately fetched verified asset groups without replacing prior files', async () => {
      await withFixture('a3-ci-github-distribution-merge-', async (root) => {
          const release = prepareRelease(root);
          const projectRoot = path.join(root, 'consumer');
          fs.mkdirSync(projectRoot);
          await fetchDistribution({
            projectRoot,
            manifest: release.manifest,
            manifestBytes: release.manifestBytes,
            requestedPresets: [],
            requestedAssets: ['registry.ci-github'],
            sourceRoot: repositoryRoot,
          });
          const merged = await fetchDistribution({
            projectRoot,
            manifest: release.manifest,
            manifestBytes: release.manifestBytes,
            requestedPresets: [],
            requestedAssets: ['lint.github-actions'],
            sourceRoot: repositoryRoot,
          });
          expect(merged.action).toBe('merged');
          expect(merged.selectedAssets).toStrictEqual(['lint.github-actions', 'registry.ci-github']);
          expect(fs.existsSync(path.join(merged.distributionRoot, 'skills/ci-github/assets/registry/ci-distribution-assets.yml'))).toBeTruthy();
          expect(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/a3-lint/ci_github_workflow_name_matches_file.lua'))).toBeTruthy();
          expect(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/a3-lint/shared/ci_github_yaml.lua'))).toBeTruthy();
          expect(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/a3-lint/ci_github_action_runtime_contract.lua'))).toBe(false);
          expect(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/repository'))).toBe(false);
          expect(fs.existsSync(path.join(merged.distributionRoot, 'runtime/repository/check-provider-references.mjs'))).toBe(false);
      });
    });
  });
});


describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution-delivery", () => {
    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('remote fetch reuses verified files for repeat and extended preset selections', async () => {
      // Arrange
      await withFixture('distribution-remote-reuse-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const requestedPaths = (preset) => [...new Set(resolveDistributionSelection(release.manifest, [preset], [])
          .flatMap((asset) => asset.files.map((file) => file.sourcePath)))].sort();
        const requestPaths = requestedPaths('release-request');
        const qualityPaths = requestedPaths('quality-gate');
        const calls = [];
        const fetch = (preset) => fetchDistribution({
          projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          requestedPresets: [preset], requestedAssets: [],
          download: async (url) => {
            const relative = url.split(`/${sourceRevision}/`)[1];
            calls.push(relative);
            return fs.readFileSync(path.join(committedSourceRoot, relative));
          },
        });

        // Act / Assert
        const first = await fetch('release-request');
        expect(calls.sort()).toEqual(requestPaths);
        expect(first.action).toBe('fetched');
        const receiptBeforeRepeat = fs.readFileSync(path.join(first.distributionRoot, 'receipt.json'));
        calls.length = 0;
        const repeated = await fetch('release-request');
        expect(calls).toEqual([]);
        expect(repeated.action).toBe('merged');
        expect(fs.readFileSync(path.join(first.distributionRoot, 'receipt.json'))).toEqual(receiptBeforeRepeat);
        calls.length = 0;
        const extended = await fetch('quality-gate');
        expect(calls.sort()).toEqual(qualityPaths.filter((relative) => !requestPaths.includes(relative)));
        expect(extended.selectedPresets).toEqual(['quality-gate', 'release-request']);
        expect(verifyFetchedDistribution({ projectRoot, sourceRevision }).status).toBe('verified');
        expect(fs.existsSync(path.join(first.distributionRoot, '.fetch.lock'))).toBe(false);
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('remote fetch sends every download request to the origin that the manifest trusts', async () => {
      // Arrange
      await withFixture('distribution-remote-origin-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const log = path.join(root, 'transport.log');

        // Act
        const fetched = cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'],
          faults: { transport: { sourceRoot: committedSourceRoot, sourceRevision, log } } });

        // Assert
        expect(fetched.sourceRevision).toBe(sourceRevision);
        const requests = fs.readFileSync(log, 'utf8').trim().split('\n');
        expect(requests.every((url) => url.startsWith(`${release.manifest.rawOrigin}/${release.manifest.repository}/${sourceRevision}/`))).toBeTruthy();
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('remote fetch rejects invalid cached state and concurrent fetch locks before transport', async () => {
      // Arrange
      await withFixture('distribution-remote-cache-rejection-', async (root) => {
        const release = prepareRelease(root);
        for (const problem of ['bytes', 'receipt', 'manifest', 'lock']) {
          // Act
          const { projectRoot, diagnostic, thrown, before } = rejectCachedState(root, release, problem);

          // Assert
          expect(thrown.message, problem).toBe(diagnostic);
          expect(snapshotTree(projectRoot), problem).toEqual(before);
        }
      });
    });

    // evidence_role: supplemental
    // Whether the transport was called is an implementation mechanism of the rejection, not an observation of a guarantee.
    test('remote fetch rejects invalid cached state without calling the transport', async () => {
      await withFixture('distribution-remote-cache-transport-', async (root) => {
        const release = prepareRelease(root);
        for (const problem of ['bytes', 'receipt', 'manifest', 'lock']) {
          expect(fs.existsSync(rejectCachedState(root, release, problem).log), problem).toBe(false);
        }
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('remote fetch preserves prior state and releases its lock after an extension fails', async () => {
      // Arrange
      await withFixture('distribution-remote-extension-failure-', async (root) => {
        // Act
        const { release, projectRoot, before, failure, requests } = failExtensionFetch(root);

        // Assert
        expect(failure.message).toBe('distribution-download-failed');
        expect(requests.every((url) => url.startsWith(`${release.manifest.rawOrigin}/${release.manifest.repository}/${sourceRevision}/`))).toBeTruthy();
        expect(snapshotTree(projectRoot)).toEqual(before);
      });
    });

    // evidence_role: supplemental
    // The fetch lock, the rejected peer fetch, the peer transport and the recovery are implementation mechanisms of a failed extension, not observations of a guarantee.
    test('failed extension fetch keeps the peer off the transport, releases its lock and recovers on retry', async () => {
      await withFixture('distribution-remote-extension-record-', async (root) => {
        const { projectRoot, options, transport, lockPath, peerLog, probes } = failExtensionFetch(root);
        // The failing extension download is retried by the CLI, so every attempt after the first call must still hold the lock.
        expect(probes.length).toBeGreaterThan(1);
        expect(probes.every(({ lockPresent }) => lockPresent)).toBe(true);
        expect(probes[0].peer.status).toBe(2);
        expect(JSON.parse(probes[0].peer.stderr).diagnostic).toBe('distribution-fetch-locked');
        expect(fs.existsSync(peerLog)).toBe(false);
        expect(fs.existsSync(lockPath)).toBe(false);
        expect(cliVerify({ projectRoot, sourceRevision }).status).toBe('verified');
        const recovered = cliFetch({ ...options, faults: { transport } });
        expect(recovered.action).toBe('merged');
        expect(cliVerify({ projectRoot, sourceRevision }).status).toBe('verified');
        expect(fs.existsSync(lockPath)).toBe(false);
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('fetch rejects with the owned lock cleanup failure when closing or removing its lock fails', async () => {
      // Arrange
      await withFixture('distribution-lock-cleanup-failure-', async (root) => {
        const release = prepareRelease(root);
        for (const operation of ['close', 'remove']) {
          // Act
          const { projectRoot, failure, before } = failLockCleanup(root, release, operation);

          // Assert
          expect(failure.message, operation).toBe('distribution-lock-cleanup-failed');
          expect(failure.evidence['execution-state'].cleanupFailures, operation).toEqual([operation === 'close' ? 'lock-close' : 'lock-remove']);
          expect(consumerTree(projectRoot), operation).toEqual(before);
        }
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('fetch preserves the prior cache when cleanup rejects a cache extension', async () => {
      await withFixture('distribution-extension-cleanup-', async (root) => {
        const release = prepareRelease(root);
        for (const operation of ['close', 'remove', 'staging']) {
          const projectRoot = createConsumer(root, operation);
          const options = { projectRoot, manifestPath: release.manifestPath, sourceRoot: committedSourceRoot };
          const fetched = cliFetch({ ...options, requestedPresets: ['release-request'] });
          const before = consumerTree(projectRoot);
          const lock = { path: path.join(fetched.distributionRoot, '.fetch.lock') };
          const faults = operation === 'close' ? { failClose: [lock] } : {
            failRemove: operation === 'remove' ? [lock] : [{ pattern: '[\\\\/]\\.staging-[^\\\\/]+$' }],
          };

          const failure = failureOf(() => cliFetch({ ...options, requestedPresets: ['quality-gate'], faults }));

          expect(failure.message, operation).toBe(operation === 'staging'
            ? 'distribution-fetch-cleanup-failed' : 'distribution-lock-cleanup-failed');
          expect(failure.evidence['execution-state'].rollback, operation).toBe('restored');
          expect(consumerTree(projectRoot), operation).toEqual(before);
        }
      });
    });

    // evidence_role: supplemental
    // Calling the transport and leaving a staging directory are implementation mechanisms of the fetch, not observations of a guarantee.
    test('fetch removes staging and skips the transport even when closing or removing its owned lock fails', async () => {
      await withFixture('distribution-lock-cleanup-record-', async (root) => {
        const release = prepareRelease(root);
        for (const operation of ['close', 'remove']) {
          const { projectRoot, log } = failLockCleanup(root, release, operation);
          expect(fs.existsSync(log), operation).toBe(false);
          expect(fs.readdirSync(path.join(projectRoot, '.a3-skills/ci-github')).filter((name) => name.startsWith('.staging-')), operation).toEqual([]);
        }
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('fetch retains validation failure and cached files when lock and staging cleanup fail', async () => {
      await withFixture('distribution-primary-cleanup-', async (root) => {
        const release = prepareRelease(root);
        for (const operation of ['lock', 'staging', 'both']) {
          const projectRoot = createConsumer(root, operation);
          const options = { projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'] };
          const fetched = cliFetch({ ...options, sourceRoot: committedSourceRoot });
          const before = consumerTree(projectRoot);
          const failRemove = [
            ...(operation !== 'staging' ? [{ path: path.join(fetched.distributionRoot, '.fetch.lock') }] : []),
            ...(operation !== 'lock' ? [{ pattern: '[\\\\/]\\.staging-[^\\\\/]+$' }] : []),
          ];
          const failure = failureOf(() => cliFetch({ ...options, requestedPresets: ['quality-gate'],
            faults: { failRemove, transport: { body: 'corrupt' } } }));
          expect(failure.message, operation).toBe('distribution-file-integrity-mismatch');
          expect(failure.evidence['execution-state'].write, operation).toBe('not-started');
          expect(failure.evidence['execution-state'].cleanupFailures, operation).toEqual(operation === 'lock' ? ['lock-remove']
            : operation === 'staging' ? ['staging-remove'] : ['lock-remove', 'staging-remove']);
          expect(consumerTree(projectRoot), operation).toEqual(before);
          expect(cliVerify({ projectRoot, sourceRevision }).status, operation).toBe('verified');
        }
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('explicit source root remains validated when a verified distribution already exists', async () => {
      // Arrange
      await withFixture('distribution-repeat-source-validation-', async (root) => {
        // Act
        const { projectRoot, thrown, before } = rejectInvalidSourceRoot(root);

        // Assert
        expect(thrown.message).toBe('distribution-file-integrity-mismatch');
        expect(snapshotTree(projectRoot)).toEqual(before);
      });
    });

    // evidence_role: supplemental
    // Whether the transport was called is an implementation mechanism of the rejection, not an observation of a guarantee.
    test('explicit source root rejection does not call the transport', async () => {
      await withFixture('distribution-repeat-source-transport-', async (root) => {
        expect(fs.existsSync(rejectInvalidSourceRoot(root).log)).toBe(false);
      });
    });
  });
});



describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution-delivery", () => {
    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('remote fetch rejects invalid redirect and transport responses without publishing consumer assets', async () => {
      // Arrange
      await withFixture('distribution-remote-rejection-', async (root) => {
        // Act
        const { release, projectRoot, before, results } = failDownloads(root);
        for (const { label, failure, observed, requests, after } of results) {
          // Assert
          expect(failure.message, label).toBe('distribution-download-failed');
          expect(failure.evidence.comparison.observed, label).toBe(observed);
          expect(requests.every((url) => url.startsWith(`${release.manifest.rawOrigin}/${release.manifest.repository}/${sourceRevision}/`)), label).toBeTruthy();
          expect(after, label).toStrictEqual(before);
        }
      });
    });

    // evidence_role: supplemental
    // Whether the transport was called is an implementation mechanism of the rejection, not an observation of a guarantee.
    test('remote fetch calls the transport before a failed download is rejected', async () => {
      await withFixture('distribution-remote-rejection-requests-', async (root) => {
        for (const { label, requests } of failDownloads(root).results) expect(requests.length > 0, label).toBeTruthy();
      });
    });
  });
});


describe("contract.ci-selective-distribution.application", () => {
  describe("selective-distribution-application", () => {
    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.plan
    // integration_id: selective-distribution-application
    test('plan rejects malformed prior ownership locks before changing consumer state', async () => {
      // Arrange
      await withFixture('distribution-prior-lock-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const lockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
        fs.mkdirSync(path.dirname(lockPath));
        const valid = { schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision,
          assets: [{ path: '.github/workflows/quality-gate.yml', appliedSha256: 'a'.repeat(64) }] };
        const cases = [
          ['schema', (lock) => { lock.schemaVersion = '2'; }],
          ['revision', (lock) => { lock.sourceRevision = 'main'; }],
          ['missing revision', (lock) => { delete lock.sourceRevision; }],
          ['assets type', (lock) => { lock.assets = {}; }],
          ['missing assets', (lock) => { delete lock.assets; }],
          ['null entry', (lock) => { lock.assets = [null]; }],
          ['path type', (lock) => { lock.assets[0].path = 42; }],
          ['duplicate path', (lock) => { lock.assets.push({ ...lock.assets[0] }); }],
          ['digest', (lock) => { lock.assets[0].appliedSha256 = 'invalid'; }],
          ['missing digest', (lock) => { delete lock.assets[0].appliedSha256; }],
        ];
        const malformedLocks = cases.map(([label, mutate]) => {
          const lock = structuredClone(valid);
          mutate(lock);
          return [label, JSON.stringify(lock)];
        });
        malformedLocks.push(['malformed JSON', '{'], ['null document', 'null'], ['boolean document', 'false']);
        for (const [label, bytes] of malformedLocks) {
          fs.writeFileSync(lockPath, bytes);
          const before = snapshotTree(projectRoot);
          // Act / Assert
          const failure = failureOf(() => cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] }));
          expect(failure.message, label).toBe('distribution-prior-asset-lock-invalid');
          expect(failure.evidence.classification, label).toMatchObject({
            operation: 'plan', stage: 'prior-ownership-validation',
          });
          expect(snapshotTree(projectRoot), label).toStrictEqual(before);
        }
      });
    });

    // contract_id: contract.ci-selective-distribution.plan
    test('plan rejects a preset whose assets were not fetched without modifying the consumer tree', async () => {
      await withFixture('distribution-plan-unfetched-', (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'],
          sourceRoot: committedSourceRoot });
        const before = snapshotTree(projectRoot);

        expect(() => cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], settings: {} }))
          .toThrow(/^distribution-selection-not-fetched$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });

    // contract_id: contract.ci-selective-distribution.plan
    test('plan exposes its digest actions and previously managed paths outside the selection', async () => {
      await withFixture('distribution-plan-evidence-', (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'],
          sourceRoot: committedSourceRoot });
        const stalePath = '.github/workflows/retired.yml';
        const lockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: '1', kind: 'ci-github-asset-lock',
          sourceRevision, assets: [{ path: stalePath, appliedSha256: sha256('previously managed bytes') }] }));

        const { planPath, planDigest, ...payload } = cliPlan({ projectRoot, sourceRevision,
          requestedPresets: ['quality-gate'], requestedAssets: [] });

        expect(planDigest).toBe(sha256(`${JSON.stringify(payload, null, 2)}\n`));
        expect(JSON.parse(fs.readFileSync(planPath, 'utf8'))).toEqual({ ...payload, planDigest });
        expect(payload.actions.map(({ destination, action }) => ({ destination, action })))
          .toEqual([{ destination: '.github/workflows/quality-gate.yml', action: 'create' }]);
        expect(payload.stale).toEqual([stalePath]);
      });
    });

    // contract_id: contract.ci-selective-distribution.plan
    test('plan reports a conflict without replacing an independently edited destination', async () => {
      await withFixture('distribution-plan-independent-destination-', (root) => {
        const { options, workflow, workflowPath } = prepareOwnedWorkflow(root);
        const edit = Buffer.from('independent consumer edit\n');
        fs.writeFileSync(workflow, edit);

        const plan = cliPlan(options);

        expect(plan.actions).toContainEqual(expect.objectContaining({ destination: workflowPath, action: 'conflict' }));
        expect(fs.readFileSync(workflow)).toStrictEqual(edit);
      });
    });

    // contract_id: contract.ci-selective-distribution.plan
    test('plan reuses current destinations and updates destinations with owned older bytes', async () => {
      await withFixture('distribution-plan-owned-destinations-', (root) => {
        const { options, workflow, workflowPath, canonical, writeOwnership } = prepareOwnedWorkflow(root);
        expect(cliPlan(options).actions).toContainEqual(expect.objectContaining({ destination: workflowPath, action: 'reuse' }));

        const older = Buffer.from(canonical.toString('utf8').replaceAll('ubuntu-24.04', 'ubuntu-22.04'));
        expect(older).not.toEqual(canonical);
        fs.writeFileSync(workflow, older);
        writeOwnership(older);

        expect(cliPlan(options).actions).toContainEqual(expect.objectContaining({ destination: workflowPath, action: 'update' }));
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.application
    // integration_id: selective-distribution-application
    test('approved plans reuse identical workflows update owned bytes and reject unmanaged changes', async () => {
      // Arrange
      await withFixture('distribution-owned-update-', async (root) => {
        const { projectRoot, projectDocument, options, workflow, canonical, lockPath, writeOwnership } = prepareOwnedWorkflow(root);
        const reuse = cliPlan(options);
        // Act
        const reused = cliApply({ projectRoot, planPath: reuse.planPath, approvalDigest: reuse.planDigest });
        // Assert
        expect(reuse.actions.map((entry) => entry.action)).toStrictEqual(['reuse']);
        expect(fs.readFileSync(workflow)).toStrictEqual(canonical);
        cliRollback({ projectRoot, transactionId: reused.transactionId });
        expect(fs.readFileSync(workflow)).toStrictEqual(canonical);
        // Arrange
        const oldManagedBytes = Buffer.from(canonical.toString('utf8').replaceAll('ubuntu-24.04', 'ubuntu-22.04'));
        fs.writeFileSync(workflow, oldManagedBytes);
        writeOwnership(oldManagedBytes);
        const ownershipBefore = fs.readFileSync(lockPath);
        const preserved = cliPlan({ ...options, settings: {} });
        expect(preserved.actions.map((entry) => entry.action)).toEqual(['reuse']);
        expect(preserved.actions[0].generatedContent).toBe(oldManagedBytes.toString('utf8'));
        const update = cliPlan(options);
        // Act
        const updated = cliApply({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest });
        // Assert
        expect(update.actions.map((entry) => entry.action)).toStrictEqual(['update']);
        expect(fs.readFileSync(workflow)).toStrictEqual(canonical);
        expect(fs.readFileSync(lockPath)).toStrictEqual(ownershipBefore);
        // Act
        const rolledBack = cliRollback({ projectRoot, transactionId: updated.transactionId });
        // Assert
        expect(rolledBack.rollbackStatus).toBe('restored');
        expect(fs.readFileSync(workflow)).toStrictEqual(oldManagedBytes);
        expect(fs.readFileSync(lockPath)).toStrictEqual(ownershipBefore);
        expect(fs.readFileSync(projectDocument, 'utf8')).toBe('project-owned content');
        // Arrange
        fs.writeFileSync(workflow, 'unmanaged project edit');
        const conflict = cliPlan(options);
        const before = snapshotTree(projectRoot);
        // Act / Assert
        expect(conflict.actions.map((entry) => entry.action)).toStrictEqual(['conflict']);
        expect(() => cliApply({ projectRoot, planPath: conflict.planPath,
          approvalDigest: conflict.planDigest })).toThrow(/^distribution-plan-has-conflicts$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });

    // evidence_role: supplemental
    // The transaction record layout is an implementation mechanism of apply and rollback, not an observation of a guarantee.
    test('reuse records no transaction action and update backs up the owned bytes', async () => {
      await withFixture('distribution-owned-transaction-', async (root) => {
        const { projectRoot, options, workflowPath, workflow, canonical, writeOwnership } = prepareOwnedWorkflow(root);
        const reuse = cliPlan(options);
        const reused = cliApply({ projectRoot, planPath: reuse.planPath, approvalDigest: reuse.planDigest });
        const reusedTransaction = path.join(projectRoot, '.a3-skills/ci-github/transactions', reused.transactionId);
        expect(JSON.parse(fs.readFileSync(path.join(reusedTransaction, 'transaction.json'), 'utf8')).actions).toStrictEqual([]);
        cliRollback({ projectRoot, transactionId: reused.transactionId });
        const oldManagedBytes = Buffer.from(canonical.toString('utf8').replaceAll('ubuntu-24.04', 'ubuntu-22.04'));
        fs.writeFileSync(workflow, oldManagedBytes);
        writeOwnership(oldManagedBytes);
        const update = cliPlan(options);
        const updated = cliApply({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest });
        const transactionRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions', updated.transactionId);
        expect(fs.readFileSync(path.join(transactionRoot, 'before', workflowPath))).toStrictEqual(oldManagedBytes);
      });
    });
  });
});



describe('contract.ci-selective-distribution.application', () => {
  describe('selective-distribution-recovery', () => {
    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.application
    // integration_id: selective-distribution-recovery
    test('rollback retains its original rejection when owned lock cleanup fails', async () => {
      await withFixture('distribution-rollback-cleanup-', async (projectRoot) => {
        const { failure, transactionId } = failRollbackCleanup(projectRoot);
        expect(failure.message).toBe('distribution-transaction-missing');
        expect(failure.evidence.classification).toMatchObject({
          stage: 'transaction-validation', reason: 'distribution-transaction-missing',
        });
        expect(failure.evidence['evidence-location'].transaction).toBe(transactionId);
        expect(failure.evidence['execution-state']).toMatchObject({ write: 'not-started', rollback: 'unavailable',
          cleanup: 'lock-cleanup-failed', cleanupFailures: ['lock-remove'] });
      });
    });

    // contract_id: contract.ci-selective-distribution.rollback
    test('rollback rejects malformed transaction metadata before restoring files', async () => {
      await withFixture('distribution-rollback-invalid-record-', (root) => {
        const { projectRoot, plan } = prepareQualityPlan(root);
        const { transactionId } = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const recordPath = path.join(projectRoot, '.a3-skills/ci-github/transactions', transactionId, 'transaction.json');
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        for (const bytes of ['{', 'null', JSON.stringify({ ...record, actions: null })]) {
          fs.writeFileSync(recordPath, bytes);
          const before = snapshotTree(projectRoot);
          const failure = failureOf(() => cliRollback({ projectRoot, transactionId }));
          expect(failure.message).toBe('distribution-transaction-not-rollbackable');
          expect(failure.evidence.classification).toMatchObject({ operation: 'rollback', stage: 'transaction-validation' });
          expect(snapshotTree(projectRoot)).toStrictEqual(before);
        }
      });
    });

    // evidence_role: supplemental
    // The retained lock and the preserved state file are side effects of the failed cleanup, not observations of a guarantee.
    test('rollback of a missing transaction keeps its lock and the existing state file when lock cleanup fails', async () => {
      await withFixture('distribution-rollback-cleanup-record-', async (projectRoot) => {
        const { lock, existing } = failRollbackCleanup(projectRoot);
        expect(fs.existsSync(lock)).toBe(true);
        expect(fs.readFileSync(existing, 'utf8')).toBe('preserved\n');
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.application
    // integration_id: selective-distribution-recovery
    test('successful apply and rollback report cleanup failure with the completed transaction state', async () => {
      await withFixture('distribution-completed-cleanup-', async (root) => {
        const release = prepareRelease(root);
        for (const operation of ['apply', 'rollback']) {
          const { failure } = failCompletedCleanup(root, release, operation);
          expect(failure.message, operation).toBe('distribution-lock-cleanup-failed');
          expect(failure.evidence.classification.stage, operation).toBe('lock-cleanup');
          expect(failure.evidence['execution-state'].write, operation).toBe(operation === 'apply' ? 'applied' : 'rolled-back');
          expect(failure.evidence['execution-state'].rollback, operation).toBe(operation === 'apply' ? 'not-required' : 'restored');
          expect(failure.evidence['evidence-location'].transaction, operation).toMatch(/^[0-9]+-[0-9a-f]{12}$/);
        }
      });
    });

    // evidence_role: supplemental
    // The transaction status, the consumer files and the retained lock are side effects of the failed cleanup, not observations of a guarantee.
    test('completed apply and rollback keep their transaction status, consumer files and lock when lock cleanup fails', async () => {
      await withFixture('distribution-completed-cleanup-record-', async (root) => {
        const release = prepareRelease(root);
        for (const operation of ['apply', 'rollback']) {
          const { projectRoot, plan, lock, failure } = failCompletedCleanup(root, release, operation);
          const transaction = JSON.parse(fs.readFileSync(path.join(projectRoot, '.a3-skills/ci-github/transactions',
            failure.evidence['evidence-location'].transaction, 'transaction.json'), 'utf8'));
          expect(transaction.status, operation).toBe(operation === 'apply' ? 'applied' : 'rolled-back');
          for (const entry of plan.actions) {
            const target = path.join(projectRoot, entry.destination);
            if (operation === 'apply') expect(fs.readFileSync(target, 'utf8')).toBe(entry.generatedContent);
            else expect(fs.existsSync(target)).toBe(false);
          }
          expect(fs.existsSync(lock), operation).toBe(true);
        }
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.application
    // integration_id: selective-distribution-recovery
    test('rollback retains the restoration error when recording recovery state also fails', async () => {
      await withFixture('distribution-rollback-record-', async (root) => {
        const release = prepareRelease(root);
        for (const lockCleanupFails of [false, true]) {
          const { applied, failure } = failRollbackRecord(root, release, lockCleanupFails);
          expect(failure.message).toBe('distribution-unknown-failure');
          expect(failure.evidence['evidence-location'].transaction).toBe(applied.transactionId);
          expect(failure.evidence['execution-state']).toMatchObject({ write: 'partial-output', rollback: 'failed',
            cleanup: lockCleanupFails ? 'lock-cleanup-failed' : 'transaction-record-write-failed' });
          if (lockCleanupFails) expect(failure.evidence['execution-state'].cleanupFailures).toEqual(['lock-remove']);
        }
      });
    });

    // evidence_role: supplemental
    // The target bytes, the transaction record status and the retained lock are side effects of the failed recovery recording, not observations of a guarantee.
    test('failed rollback recording keeps the target bytes, the rolling-back record and the lock as they were', async () => {
      await withFixture('distribution-rollback-record-state-', async (root) => {
        const release = prepareRelease(root);
        for (const lockCleanupFails of [false, true]) {
          const { transactionPath, target, before, lockPath } = failRollbackRecord(root, release, lockCleanupFails);
          expect(fs.readFileSync(target)).toEqual(before);
          expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).status).toBe('rolling-back');
          expect(fs.existsSync(lockPath)).toBe(lockCleanupFails);
        }
      });
    });
  });
});
