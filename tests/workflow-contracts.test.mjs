import { existsSync, globSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { checkActionReferences, checkProviderReferences, checkRepository, registryPath, repositorySnapshot } from '../runtime/repository/check-provider-references.mjs';
import { verifyActionReferenceContracts } from '../runtime/repository/verify-action-reference-contracts.mjs';
import { collectActionPackages, sharedRuntimeVerificationPlan, verificationPlan } from '../runtime/repository/verify-action-packages.mjs';
import vitestConfig from '../vitest.config.mjs';
import path from 'node:path';
import { test, describe, expect, onTestFinished } from 'vitest';
import { runInNewContext } from 'node:vm';
import { releaseSkillsFixture } from '../runtime/release-publication/tests/fixtures.mjs';
import { spawnTimeoutMs, root, read, actionRef, includesAll, jobBlock, stepContaining, stepBlock, summaryNeeds, assertNeeds, unitRecord, referenceFixture, pinOldActionReferences } from "./workflow-contracts.fixtures.mjs";

describe('contract.ci-release-assembly.outputs', () => {
  describe('same-release-skills', () => {
    // evidence_role: supplemental
    // integration_id: same-release-skills-asset-collision
    test('skills ZIP rejects a collision with a product asset before output', (t) => {
      // Arrange
      const f = releaseSkillsFixture(t);
      const directory = path.join(f.root, 'build/release-build-linux');
      const name = 'project-skills.zip';
      renameSync(path.join(directory, f.name), path.join(directory, name));
      renameSync(path.join(directory, `${f.name}.sha256`), path.join(directory, `${name}.sha256`));
      f.put(`build/release-build-linux/${name}.sha256`, `${f.buildManifest.assets[0].sha256}  ${name}\n`);
      f.buildManifest.assets[0].path = name;
      f.buildManifest.assets[0].checksum_path = `${name}.sha256`;
      f.put('build/release-build-linux/asset-manifest.json', f.buildManifest);
      // Act
      const assemble = f.assemble;
      // Assert
      expect(assemble).toThrow(/asset-name-collision/);
      expect(existsSync(f.options.outputRoot)).toBe(false);
    });
  });
});


describe('installer public naming references', () => {
  // evidence_role: supplemental
  // integration_id: standard-installer-entry-samples
  // test_level: integration
  describe('samples', () => {
  test('README and assembly samples use the authoritative public entry names', () => {
    // Arrange
    const contract = yaml.parse(read('skills/ci-release-installer/references/installer-standard-assembly-contract.reference.yml'));
    // Act
    const declaration = JSON.parse(read('skills/ci-release-installer/assets/examples/standard-assembly.example.json'));
    const readme = read('skills/ci-release-installer/assets/examples/readme-installation.example.md');
    // Assert
    expect(declaration.platforms[contract.publicEntryNames.windows.platform].assetName).toBe(contract.publicEntryNames.windows.assetName);
    expect(declaration.sharedWrapper.assetName).toBe(contract.publicEntryNames.unixShared.assetName);
    expect(readme).toContain(`/releases/download/<release-tag>/${contract.publicEntryNames.windows.assetName}' | iex`);
    expect(readme).toContain(`/releases/download/<release-tag>/${contract.publicEntryNames.unixShared.assetName}' | sh`);
  });
  });
});


describe('contract.ci-selective-distribution.publication', () => {
  describe('repository-provider-binding', () => {
  test('repository CI validates untagged connection candidates and preserves implementation preparation', () => {
    const step = yaml.parse(read('.github/workflows/quality-gate.yml')).jobs['contract-linux'].steps.find((entry) => entry.id === 'provider-binding');
    const script = /<<'NODE'\n([\s\S]*?)\nNODE/.exec(step.run)?.[1];
    expect(script).toBeDefined();
    const code = script.split('\n').filter((line) => !line.startsWith('import ')).join('\n');
    // A same-named tag is published state even when it does not contain the bound implementation.
    for (const [version, releaseTag, tagPresent, mode] of [['0.3.0\n', 'v0.2.11', true, '--preparation'], ['0.2.11\n', 'v0.2.10', true, '--preparation'], ['0.2.11\n', 'v0.2.11', false, '--candidate'], ['0.2.11\n', 'v0.2.11', true, '--preparation']]) {
      const calls = [];
      const context = {
        process: { cwd: () => root, execPath: process.execPath },
        readFileSync: (filename) => { expect(filename).toBe('VERSION'); return version; },
        repositorySnapshot: () => ({ registry: { actionization: { implementationSource: { releaseTag, exactRef: actionRef } } } }),
        execFileSync: (command, ...args) => {
          if (command === 'git') {
            expect(args).toEqual([['tag', '--list', releaseTag], { encoding: 'utf8' }]);
            return tagPresent ? `${releaseTag}\n` : '';
          }
          calls.push([command, ...args]);
        },
      };
      runInNewContext(code, context);
      expect(calls).toEqual([[process.execPath, ['runtime/repository/check-provider-references.mjs', '--contracts', mode], { stdio: 'inherit' }]]);
      expect(() => runInNewContext(code, { ...context, execFileSync: () => { throw new Error('fixed-reference-contract-failed'); } })).toThrow('fixed-reference-contract-failed');
      expect(() => runInNewContext(code, { ...context, repositorySnapshot: () => { throw new Error('registry-invalid'); } })).toThrow('registry-invalid');
    }
  });
  });
});


describe("workflow-contracts", () => {
  describe("quality-workflow-contract", () => {

    // integration_id: quality-workflow-contract
    test('quality caller passes explicit inputs and preserves the summary check without copying quality jobs', () => {
      const caller = yaml.parse(read('workflows/quality/quality-gate.yml'));
      const callee = yaml.parse(read('.github/workflows/ci-quality.yml'));
      expect(Object.keys(caller.jobs)).toStrictEqual(['quality', 'summary']);
      expect(caller.env).toBe(undefined);
      expect(caller.jobs.quality.steps).toBe(undefined);
      expect(caller.jobs.quality.secrets).toBe(undefined);
      expect(caller.jobs.quality.permissions.contents).toBe('read');
      expect(caller.jobs.quality.uses).toBe('a3-suite/a3-ci-github/.github/workflows/ci-quality.yml@<quality-workflow-sha>');
      expect(Object.keys(caller.jobs.quality.with).sort()).toStrictEqual(Object.keys(callee.on.workflow_call.inputs).sort());
      expect(Object.keys(callee.on)).toStrictEqual(['workflow_call']);
      expect(callee.on.workflow_call.secrets).toBe(undefined);
      expect(callee.concurrency).toBe(undefined);
      expect(caller.jobs.summary.needs).toBe('quality');
      expect(caller.jobs.summary.if).toBe('always()');
      expect(caller.jobs.summary.name).toBe(undefined);
      expect(Object.keys(callee.jobs)).toStrictEqual(['trusted', 'untrusted-pr', 'summary']);
      expect(callee.on.workflow_call.inputs['jq-version'].required).toBe(false);
      expect(callee.on.workflow_call.inputs['jq-version'].default).toBe('');
      for (const id of ['trusted', 'untrusted-pr']) {
        const steps = callee.jobs[id].steps;
        const jqSteps = steps.filter((step) => /actions\/ci-(?:jq-provisioner|github-toolchain-verifier)@/.test(step.uses ?? ''));
        expect(jqSteps.length).toBe(2);
        for (const step of jqSteps) {
          expect(step.if).toBe("steps.change-scope.outputs['run-ci'] != 'false' && env.CI_JQ_VERSION != ''");
          expect(step.with['jq-version']).toBe('${{ env.CI_JQ_VERSION }}');
        }
        for (const step of steps.filter((step) => /actions\/ci-quality-(?:toolchain|adapter)@/.test(step.uses ?? ''))) {
          expect(step.if).toBe("steps.change-scope.outputs['run-ci'] != 'false'");
        }
      }
    });
  });
});


describe("workflow-contracts", () => {
  describe("quality-workflow-contract", () => {

    // integration_id: quality-workflow-contract
    test('quality workflow declares trusted execution and aggregate summary', () => {
      const workflow = read('.github/workflows/ci-quality.yml').replaceAll('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@<commit-sha>');
      includesAll(workflow, [/workflow_call:/, /permissions:\n  contents: read/]);
      const trusted = jobBlock(workflow, 'trusted');
      expect(trusted).toMatch(/^    if: \$\{\{ github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository \}\}$/m);
      includesAll(stepBlock(trusted, '- uses: actions/checkout@<commit-sha>'), [
        /^      - uses: actions\/checkout@<commit-sha>$/m,
        /^          ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m,
      ]);
      includesAll(stepBlock(trusted, '- name: Checkout trusted CI assets'), [
        /^        uses: actions\/checkout@<commit-sha>$/m,
        /^          ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}$/m,
        /^          path: \.ci-base$/m,
      ]);
      includesAll(stepBlock(trusted, '- name: Run project quality adapter'), [
        /^        id: quality-adapter$/m,
        new RegExp(`^        uses: a3-suite/a3-ci-github/actions/ci-quality-adapter@${actionRef}$`, 'm'),
        /^          trusted-project-root: \$\{\{ steps\.trusted-assets\.outputs\.root \}\}$/m,
      ]);
      const untrusted = jobBlock(workflow, 'untrusted-pr');
      expect(untrusted).toMatch(/^    if: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name != github\.repository \}\}$/m);
      includesAll(stepBlock(untrusted, '- uses: actions/checkout@<commit-sha>'), [
        /^          ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m,
      ]);
      includesAll(stepBlock(untrusted, '- name: Checkout trusted CI assets'), [
        /^          ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/m,
        /^          path: \.ci-base$/m,
      ]);
      includesAll(stepBlock(untrusted, '- name: Run project quality adapter'), [
        new RegExp(`^        uses: a3-suite/a3-ci-github/actions/ci-quality-adapter@${actionRef}$`, 'm'),
        /^          standard-bundle-id: \$\{\{ env\.CI_STANDARD_BUNDLE_ID \}\}$/m,
      ]);
      const summary = jobBlock(workflow, 'summary');
      assertNeeds(summary, ['trusted', 'untrusted-pr']);
      includesAll(summary, [/if: always\(\)/, /uses: a3-suite\/a3-ci-github\/actions\/ci-quality-summary@/]);
      const main = yaml.parse(workflow).jobs;
      const ordered = main.trusted.steps;
      const adapterIndex = ordered.findIndex((step) => step.id === 'quality-adapter');
      expect(adapterIndex).toBeGreaterThan(ordered.findIndex((step) => step.name === 'Checkout trusted CI assets'));
      expect(adapterIndex).toBeGreaterThan(ordered.findIndex((step) => step.id === 'trusted-assets'));
      const platforms = yaml.parse(read('.github/workflows/ci-quality-platforms.yml')).jobs;
      const baseCheckout = (job) => job.steps.find((step) => step.name === 'Checkout trusted CI assets');
      const resolver = main.trusted.steps.find((step) => step.id === 'trusted-assets');
      const standardBundles = JSON.parse(read('runtime/adapter/standard-quality-bundles.generated.ts')
        .match(/^export const STANDARD_QUALITY_BUNDLES = (\[[\s\S]*\]) as const;$/m)[1]);
      // Evaluate only the lowercase string comparisons and boolean operators exercised by these fixtures.
      const selected = (step, id, descriptor = '', runCi = 'true', root = '.ci-base') => runInNewContext(
        step.if.replaceAll('steps.change-scope', "steps['change-scope']").replaceAll('needs.resolve-platforms', "needs['resolve-platforms']"),
        { env: { CI_STANDARD_BUNDLE_ID: id, CI_ADAPTER_DESCRIPTOR: descriptor },
          steps: { 'change-scope': { outputs: { 'run-ci': runCi } } },
          needs: { 'resolve-platforms': { outputs: { trusted_root: root } } } },
      );
      for (const [id, descriptor, required] of [
        ['rust-cargo-quality', '', false], ['python-uv-quality', '', false],
        ['typescript-npm-quality', '', true], ['', '.ci/adapters/custom.yml', true],
        ['rust-cargo-quality', '.ci/adapters/custom.yml', true], ['unknown', '', true],
      ]) {
        expect(selected(baseCheckout(main.trusted), id, descriptor), `${id}: trusted checkout`).toBe(required);
        expect(selected(resolver, id, descriptor), `${id}: trusted resolver`).toBe(required);
        expect(selected(baseCheckout(main['untrusted-pr']), id, descriptor), `${id}: fork checkout`).toBe(descriptor !== '');
        expect(selected(baseCheckout(platforms.platform), id, descriptor), `${id}: platform checkout`).toBe(required);
        expect(selected(baseCheckout(platforms.platform), id, descriptor, 'true', '.'), `${id}: platform bootstrap`).toBe(false);
        expect(selected(baseCheckout(main.trusted), id, descriptor, 'false'), `${id}: docs-only checkout`).toBe(false);
        expect(selected(resolver, id, descriptor, 'false'), `${id}: docs-only resolver`).toBe(false);
        expect(selected(baseCheckout(main['untrusted-pr']), id, descriptor, 'false'), `${id}: docs-only fork`).toBe(false);
        if (!required) {
          const bundle = standardBundles.find((entry) => entry.id === id);
          expect(yaml.parse(bundle.descriptor).projectSettings.requiredScripts, `${id}: skipped trusted root must remain unused`).toStrictEqual([]);
        }
      }
      expect(baseCheckout(platforms['resolve-platforms']).if, 'manifest and selection resolution still require base assets').toBe(undefined);
    });

    // integration_id: quality-workflow-contract
    test('platform caller passes explicit inputs and retains the summary identity', () => {
      const caller = yaml.parse(read('workflows/quality/quality-gate-platforms.yml'));
      const callee = yaml.parse(read('.github/workflows/ci-quality-platforms.yml'));
      expect(Object.keys(caller.jobs)).toStrictEqual(['platforms', 'platform-summary']);
      expect(caller.env).toBe(undefined);
      expect(caller.jobs.platforms.steps).toBe(undefined);
      expect(caller.jobs.platforms.secrets).toBe(undefined);
      expect(caller.jobs.platforms.permissions).toStrictEqual({ contents: 'read' });
      expect(caller.jobs.platforms.uses).toBe('a3-suite/a3-ci-github/.github/workflows/ci-quality-platforms.yml@<quality-platforms-workflow-sha>');
      expect(Object.keys(caller.jobs.platforms.with).sort()).toStrictEqual(Object.keys(callee.on.workflow_call.inputs).sort());
      expect(Object.keys(callee.on)).toStrictEqual(['workflow_call']);
      expect(callee.on.workflow_call.secrets).toBe(undefined);
      expect(callee.concurrency).toBe(undefined);
      expect(caller.jobs['platform-summary'].name).toBe('quality-gate-platforms / summary');
      expect(callee.jobs['platform-summary'].name).not.toBe(caller.jobs['platform-summary'].name);
      expect(caller.jobs['platform-summary'].needs).toBe('platforms');
      expect(caller.jobs['platform-summary'].if).toBe('always()');
      expect(Object.keys(callee.jobs)).toStrictEqual(['resolve-platforms', 'platform', 'platform-summary']);
    });

    // integration_id: quality-workflow-contract
    test('optional platform quality workflow preserves trusted assets matrix execution and summary', () => {
      const workflow = read('.github/workflows/ci-quality-platforms.yml');
      const resolve = jobBlock(workflow, 'resolve-platforms');
      includesAll(resolve, [
        /id: trusted-assets/,
        /pull_request\.base\.sha/,
        /matrix: .*steps\.resolve\.outputs\['quality-matrix'\]/,
        /expected: .*steps\.resolve\.outputs\['expected-platforms'\]/,
        new RegExp(`uses: a3-suite/a3-ci-github/actions/ci-platform-matrix@${actionRef}`),
        /manifest-path: .*steps\.trusted-assets\.outputs\.root.*env\.CI_PLATFORM_MANIFEST/,
        /selection-path: .*steps\.trusted-assets\.outputs\.root.*env\.CI_QUALITY_PLATFORM_SELECTION/,
        /runner-policy: \$\{\{ steps\.trusted-assets\.outputs\.source == 'base' && 'trusted' \|\| 'bootstrap' \}\}/,
        /bootstrap is limited to same-repository pull requests/,

      ]);
      expect(resolve).not.toMatch(/CoreLoader|PyYAML|pyyaml|Set up uv|uv run/);
      includesAll(jobBlock(workflow, 'platform'), [
        /needs: resolve-platforms/,
        /matrix: .*needs\.resolve-platforms\.outputs\.matrix/,
        /trusted-project-root: .*trusted_root/,
        /uses: a3-suite\/a3-ci-github\/actions\/ci-quality-adapter@/,
      ]);
      const summary = jobBlock(workflow, 'platform-summary');
      assertNeeds(summary, ['resolve-platforms', 'platform']);
      includesAll(summary, [
        /if: always\(\)/,
        /EXPECTED_PLATFORMS/,
        /uses: a3-suite\/a3-ci-github\/actions\/ci-quality-summary@/,
      ]);
    });

    // integration_id: quality-workflow-contract
    test('quality workflow keeps failed or missing checks visible', () => {
      const summary = jobBlock(read('.github/workflows/ci-quality.yml'), 'summary');
      for (const pattern of [
        /if: always\(\)/,
        /"rawResult":"\$\{\{ needs\.trusted\.result \}\}"/,
        /"applicable":\$\{\{ needs\.trusted\.result != 'skipped' \}\}/,
        /"rawResult":"\$\{\{ needs\.untrusted-pr\.result \}\}"/,
        /"applicable":\$\{\{ needs\.trusted\.result == 'skipped' \}\}/,
      ]) expect(summary).toMatch(pattern);
    });
  });
});


describe("contract.ci-selective-distribution.publication", () => {
  describe("repository-selective-distribution-release", () => {
    // contract_id: contract.ci-selective-distribution.publication
    // integration_id: repository-selective-distribution-release
    test('repository release publishes and reads back the exact selective distribution asset set before aliases', () => {
      const workflow = read('.github/workflows/release.yml');
      expect(workflow).toMatch(/^permissions: \{\}$/m);
      expect(workflow).toMatch(/workflow_dispatch:/);
      expect(workflow).not.toMatch(/^  push:/m);
      const prepare = jobBlock(workflow, 'prepare-distribution');
      includesAll(prepare, [
        /contents: read/,
        /CI_RELEASE_VALIDATE_ONLY: 'true'/,
        /source_sha: \$\{\{ steps\.release-identity\.outputs\.source_sha \}\}/,
        /tag_object: \$\{\{ steps\.release-identity\.outputs\.tag_object \}\}/,
        /generate-distribution-release\.ts/,
        /a3-ci-github-distribution-manifest\.json/,
        /fetch-a3-ci-github\.mjs/,
        /SHA256SUMS/,
        /check-provider-references\.mjs --contracts --release-tag/,
        /implementation_binding_status: \$\{\{ steps\.provider-binding\.outputs\.implementation_binding_status \}\}/,
        /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
      ]);
      expect(prepare).not.toMatch(/contents: write/);
      expect(prepare).not.toContain('actions: read');
      expect(workflow).not.toContain('acceptance-run-urls');
      expect(prepare).not.toContain('verify-hosted-workflow-acceptance.mjs');
      expect(prepare).not.toContain('--acceptance-file');
      const publish = jobBlock(workflow, 'publish-distribution');
      assertNeeds(publish, ['prepare-distribution']);
      includesAll(publish, [
        /actions: read/,
        /contents: write/,
        /manage-distribution-release\.sh publish release-distribution/,
        /GH_TOKEN: \$\{\{ github\.token \}\}/,
        /EXPECTED_SOURCE_SHA: \$\{\{ needs\.prepare-distribution\.outputs\.source_sha \}\}/,
        /EXPECTED_TAG_OBJECT: \$\{\{ needs\.prepare-distribution\.outputs\.tag_object \}\}/,
      ]);
      expect(publish).not.toMatch(/--clobber|--force/);
      expect(publish).toContain('APPROVED_RELEASE_NOTES: ${{ inputs.release-notes }}');
      const readback = jobBlock(workflow, 'readback-distribution');
      assertNeeds(readback, ['prepare-distribution', 'publish-distribution']);
      includesAll(readback, [
        /contents: read/,
        /manage-distribution-release\.sh readback release-distribution/,
        /GH_TOKEN: \$\{\{ github\.token \}\}/,
      ]);
      const aliases = jobBlock(workflow, 'update-aliases');
      assertNeeds(aliases, ['prepare-distribution', 'readback-distribution']);
      expect(aliases).toMatch(/runtime\/repository\/update-release-aliases\.sh/);
      const summary = jobBlock(workflow, 'summary');
      assertNeeds(summary, [
        'prepare-distribution',
        'publish-distribution',
        'readback-distribution',
        'update-aliases',
      ]);
      includesAll(summary, [/if: always\(\)/, /test "\$READBACK_RESULT" = success/]);
    });
  });
});


describe("workflow-contracts", () => {
  describe("release-request-workflow-contract", () => {
    // integration_id: release-request-workflow-contract
    test('release request workflow binds annotated tags without release publication permission', () => {
      const workflow = read('workflows/release/release-request-tag.yml');
      expect(workflow).toMatch(/push:\n    tags:/);
      includesAll(jobBlock(workflow, 'request'), [/permissions:\n      contents: read\n    env:/, /ci-annotated-tag-resolver@/, /ci-release-request-handoff@/]);
      const requestSteps = yaml.parse(workflow).jobs.request.steps;
      const tagIndex = requestSteps.findIndex((step) => step.uses?.includes('/ci-annotated-tag-resolver@'));
      const handoffIndex = requestSteps.findIndex((step) => step.uses?.includes('/ci-release-request-handoff@'));
      expect(tagIndex).toBeGreaterThanOrEqual(0);
      expect(handoffIndex).toBeGreaterThan(tagIndex);
      expect(workflow).not.toMatch(/contents: write/);
      expect(workflow).not.toMatch(/CI_(?:GH|JQ|SHA256SUM)_VERSION|ci-(?:gh-provisioner|jq-provisioner|github-toolchain-verifier)@/);
      includesAll(jobBlock(workflow, 'summary'), [/needs: request/, /if: always\(\)/, /permissions:\n      contents: read/, /ci-quality-summary@/]);
      expect(jobBlock(workflow, 'request')).not.toMatch(/ci-quality-summary@/);
    });

    // integration_id: release-request-workflow-contract
    test('release request workflow reports handoff failure in its summary', () => {
      const summary = jobBlock(read('workflows/release/release-request-tag.yml'), 'summary');
      for (const pattern of [/if: always\(\)/, /ci-quality-summary@/, /request job result:/, /"rawResult":"\$\{\{ needs\.request\.result \}\}"/]) expect(summary).toMatch(pattern);
    });
  });
});


describe("workflow-contracts", () => {
  describe("release-publication-workflow-contract", () => {

    // integration_id: release-publication-workflow-contract
    test('release builds overlap quality while assembly rejects every unsuccessful prerequisite', () => {
      // Arrange
      const { jobs } = yaml.parse(read('.github/workflows/ci-release-publication.yml'));
      const required = ['authority', 'source-gate', 'quality', 'build'];
      const assemble = (results, enabled = false, cancelled = false, implementation = 'owner-adapter') => runInNewContext(
        jobs.assemble.if.trim().slice(3, -2).replace(/needs\.([a-zA-Z0-9_-]+)/g, "needs['$1']"),
        { needs: Object.fromEntries(Object.entries(results).map(([id, result]) => [id, { result }])),
          inputs: { supplemental_release_asset_enabled: enabled, supplemental_release_asset_implementation: implementation }, cancelled: () => cancelled },
      );
      const successful = Object.fromEntries(required.map(id => [id, 'success']));
      // Act
      const canAssemble = assemble({ ...successful, 'supplemental-asset': 'skipped' });
      // Assert
      expect(jobs.build.needs).toStrictEqual(['authority', 'source-gate']);
      expect(jobs.build.permissions.contents).toBe('read');
      for (const id of required) expect(jobs.assemble.needs).toContain(id);
      expect(canAssemble).toBe(true);
      expect(assemble({ ...successful, 'supplemental-asset': 'success' }, true)).toBe(true);
      for (const id of required) {
        for (const result of ['failure', 'cancelled', 'skipped', '']) {
          expect(assemble({ ...successful, [id]: result, 'supplemental-asset': 'skipped' }), `${id}:${result}`).toBe(false);
        }
      }
      expect(assemble({ ...successful, 'supplemental-asset': 'failure' }, true)).toBe(false);
      expect(assemble({ ...successful, 'supplemental-asset': 'skipped' }, true)).toBe(false);
      expect(assemble({ ...successful, 'supplemental-asset': 'skipped' }, false, true)).toBe(false);
      expect(assemble({ ...successful, 'supplemental-asset': 'skipped' }, true, false, 'standard-installer')).toBe(true);
      expect(assemble({ ...successful, 'supplemental-asset': 'failure' }, true, false, 'standard-installer')).toBe(false);
      const standard = jobs.assemble.steps.find(step => step.name === 'Assemble standard installer');
      const source = jobs.assemble.steps.find(step => step.name === 'Checkout fixed assembly source');
      const handoff = jobs.assemble.steps.find(step => step.name === 'Assemble release handoff');
      const download = jobs.assemble.steps.find(step => step.with?.pattern === 'supplemental-build-*');
      expect(source.with).toMatchObject({ ref: '${{ needs.authority.outputs.source_sha }}', path: 'release-source', 'persist-credentials': false });
      expect(standard.with['source-root']).toBe(source.with.path);
      expect(handoff.with['build-root']).toBe('release-source/build');
      expect(handoff.with['authority-path']).toBe('release-source/authority/authority.json');
      expect(download.with.path).toBe('release-source/supplemental-build');
      expect(jobs.assemble.steps.indexOf(source)).toBeLessThan(jobs.assemble.steps.indexOf(download));
      expect(jobs.assemble.steps.indexOf(standard)).toBeLessThan(jobs.assemble.steps.indexOf(handoff));
      expect(jobs.assemble.permissions).toStrictEqual({ actions: 'read', contents: 'read' });
      for (const implementation of ['owner-adapter', 'standard-installer']) {
        for (const enabled of [true, false]) {
          const context = { inputs: { supplemental_release_asset_enabled: enabled, supplemental_release_asset_implementation: implementation } };
          expect(runInNewContext(jobs['supplemental-asset'].if, context)).toBe(enabled && implementation === 'owner-adapter');
          expect(runInNewContext(standard.if, context)).toBe(enabled && implementation === 'standard-installer');
          expect(runInNewContext(download.if, context)).toBe(enabled && implementation === 'standard-installer');
          const transferred = jobs.assemble.steps.find(step => step.with?.name === 'release-supplemental-asset');
          expect(runInNewContext(transferred.if, context)).toBe(enabled && implementation === 'owner-adapter');
        }
      }
      expect(jobs.publish.needs).toContain('assemble');
    });

    // integration_id: release-publication-workflow-contract
    test('release publication runs after successful assembly even when supplemental-asset is skipped', () => {
      // Arrange
      const { jobs } = yaml.parse(read('.github/workflows/ci-release-publication.yml'));
      const publish = (results, cancelled = false) => runInNewContext(
        jobs.publish.if.trim().slice(3, -2).replace(/needs\.([a-zA-Z0-9_-]+)/g, "needs['$1']"),
        { needs: Object.fromEntries(Object.entries(results).map(([id, result]) => [id, { result }])), cancelled: () => cancelled },
      );
      const successful = { authority: 'success', assemble: 'success' };
      // Act
      const canPublish = publish(successful);
      // Assert
      expect(jobs.publish.needs).toStrictEqual(['authority', 'assemble']);
      expect(canPublish).toBe(true);
      expect(publish(successful, true)).toBe(false);
      for (const id of Object.keys(successful)) {
        for (const result of ['failure', 'cancelled', 'skipped', '']) {
          expect(publish({ ...successful, [id]: result }), `${id}:${result}`).toBe(false);
        }
      }
    });

    // integration_id: release-publication-workflow-contract
    test('release publication workflows preserve failed and unknown outcomes', () => {
      const request = jobBlock(read('workflows/release/release-publication-request.yml'), 'request');
      const publication = jobBlock(read('workflows/release/release-publication-caller.yml'), 'summary');
      const caller = yaml.parse(read('workflows/release/release-publication-caller.yml'));
      expect(caller.jobs.publish.needs).toBe('validate-request');
      expect(caller.jobs.publish.if).toBeUndefined();
      for (const pattern of [/if: always\(\)/, /"rawResult":"\$\{\{ job\.status \}\}"/]) expect(request).toMatch(pattern);
      for (const pattern of [/if: always\(\)/, /"rawResult":"\$\{\{ needs\.publish\.result \}\}"/]) expect(publication).toMatch(pattern);
    });
  });
});


describe("workflow-contracts", () => {
  describe("job-execution-condition", () => {
    // GitHub's implicit success() skips a job when any transitive ancestor was skipped, even if its direct needs succeeded.
    test('jobs below a conditional ancestor declare their own status-function condition', () => {
      // Arrange
      const files = globSync(['.github/workflows/*.yml', 'workflows/**/*.yml'], { cwd: root }).sort();
      const violations = [];
      // Act
      for (const file of files) {
        const jobs = yaml.parse(read(file)).jobs ?? {};
        const ancestors = (id, seen = new Set()) => {
          for (const parent of [jobs[id]?.needs ?? []].flat()) if (!seen.has(parent)) { seen.add(parent); ancestors(parent, seen); }
          return seen;
        };
        for (const id of Object.keys(jobs)) {
          const conditional = [...ancestors(id)].filter(parent => jobs[parent]?.if !== undefined);
          if (conditional.length > 0 && !/\b(?:always|cancelled|failure)\(\)/.test(String(jobs[id].if ?? ''))) violations.push(`${file}#${id} <- ${conditional.join(',')}`);
        }
      }
      // Assert
      expect(files.length).toBeGreaterThan(0);
      expect(violations).toStrictEqual([]);
    });
  });
});


describe("workflow-contracts", () => {
  describe("package-publication-workflow-contract", () => {

    // integration_id: package-publication-workflow-contract
    test('package workflows preserve failed and unknown outcomes', () => {
      const request = jobBlock(read('workflows/package/package-publication-request.yml'), 'request');
      const publication = jobBlock(read('workflows/package/package-publication-caller.yml'), 'summary');
      const caller = yaml.parse(read('workflows/package/package-publication-caller.yml'));
      expect(caller.jobs.prepare.needs).toBe('validate-request');
      expect(caller.jobs.prepare.if).toBeUndefined();
      expect(caller.jobs.publish.needs).toStrictEqual(['validate-request', 'prepare']);
      expect(caller.jobs.publish.if).toBeUndefined();
      for (const pattern of [/if: always\(\)/, /"rawResult":"\$\{\{ job\.status \}\}"/]) expect(request).toMatch(pattern);
      for (const pattern of [/if: always\(\)/, /"rawResult":"\$\{\{ needs\.publish\.result \}\}"/]) expect(publication).toMatch(pattern);
    });
  });
});


describe("workflow-contracts", () => {
  describe("repository-quality-delivery-regression", () => {




    // contract_id: contract.ci-quality-adapter.outputs
    // integration_id: repository-quality-action-reference-contracts
    test('fixed quality Action references preserve rejection contracts and expose old registry pins', (t) => {
      // Arrange
      const fixture = referenceFixture(t);
      const current = checkRepository(fixture);
      // Act
      const accepted = verifyActionReferenceContracts(fixture, current.actionReferences, current.snapshot);
      // Assert
      const quality = accepted.observations.filter(({ case: name }) => name.startsWith('quality-'));
      expect(quality.map(({ case: name }) => name)).toEqual(['quality-custom', 'quality-reserved']);
      expect(quality.every(({ passed }) => passed)).toBe(true);
      // Arrange
      pinOldActionReferences(fixture);
      const pinned = checkRepository(fixture);
      // Act
      const rejected = verifyActionReferenceContracts(fixture, pinned.actionReferences, pinned.snapshot);
      // Assert
      expect(pinned.diagnostics).toEqual([]);
      expect(rejected.diagnostics.filter((diagnostic) => diagnostic.includes('/ci-quality-adapter@'))).toHaveLength(1);
      expect(rejected.diagnostics.join('\n')).toContain('quality-reserved');
    });

    // contract_id: contract.ci-release-publication-control.outputs
    // integration_id: repository-publication-action-reference-contracts
    test('fixed publication Action references require owner decisions and expose old registry pins', (t) => {
      // Arrange
      const fixture = referenceFixture(t);
      const current = checkRepository(fixture);
      // Act
      const accepted = verifyActionReferenceContracts(fixture, current.actionReferences, current.snapshot);
      // Assert
      const publication = accepted.observations.filter(({ case: name }) => name.startsWith('publication-'));
      expect(publication.map(({ case: name }) => name)).toEqual(['publication-valid', 'publication-INPUT_RELEASE-VERSION', 'publication-INPUT_TARGET-IDENTITY', 'publication-owner-decision']);
      expect(publication.every(({ passed }) => passed)).toBe(true);
      // Arrange
      pinOldActionReferences(fixture);
      const pinned = checkRepository(fixture);
      // Act
      const rejected = verifyActionReferenceContracts(fixture, pinned.actionReferences, pinned.snapshot);
      // Assert
      expect(pinned.diagnostics).toEqual([]);
      expect(rejected.diagnostics.filter((diagnostic) => diagnostic.includes('/ci-release-publication-control@'))).toHaveLength(1);
      expect(rejected.diagnostics.join('\n')).toContain('publication-owner-decision');
    });

    // integration_id: repository-action-reference-contracts
    test.each([
      '.github/workflows/ci-release-publication.yml',
      'workflows/release/release-publication-caller.yml',
      'actions/ci-release-publisher/action.yml',
    ])('fixed Action metadata rejects invalid paths in %s', (relative) => {
      // Arrange
      const snapshot = repositorySnapshot(root);
      const step = { uses: `a3-suite/a3-ci-github/actions/ci-release-publisher/not-an-action@${actionRef}` };
      const document = relative.startsWith('actions/') ? { runs: { using: 'composite', steps: [step] } } : { jobs: { publish: { steps: [step] } } };
      // Act
      const result = checkActionReferences(root, { ...snapshot, targets: [relative], read: () => yaml.stringify(document) });
      // Assert
      expect(result.diagnostics.join('\n')).toContain('invalid first-party Action path');
    });

    // integration_id: repository-action-reference-contracts
    test('fixed Action metadata rejects input output and installer binding drift', () => {
      // Arrange
      const snapshot = repositorySnapshot(root);
      const relative = '.github/workflows/ci-release-publication.yml';
      const workflow = yaml.parse(snapshot.read(relative));
      const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
      const control = steps.find((step) => step.uses?.includes('/ci-release-publication-control@'));
      delete control.with.operation;
      control.id = 'contract-control';
      control.with['undeclared-input'] = 'value';
      const installer = steps.find((step) => step.env?.A3_INSTALLER_PROVIDER_REVISION);
      installer.env.A3_INSTALLER_PROVIDER_REVISION = 'f'.repeat(40);
      const job = Object.values(workflow.jobs).find((job) => job.steps?.includes(control));
      job.steps.push({ run: `echo \"${'${{'} steps.${control.id}.outputs.undeclared-output }}\"` });
      // Act
      const releaseTag = snapshot.registry.actionization.implementationSource.releaseTag;
      const candidate = releaseTag === `v${read('VERSION').trim()}` && !execFileSync('git', ['tag', '--list', releaseTag], { cwd: root, encoding: 'utf8', timeout: spawnTimeoutMs }).trim();
      const result = checkActionReferences(root, { ...snapshot, read: (target) => target === relative ? yaml.stringify(workflow) : snapshot.read(target) }, { candidate });
      // Assert
      expect(result.interfaceDiagnostics.join('\n')).toContain('missing required Action input operation');
      expect(result.interfaceDiagnostics.join('\n')).toContain('undeclared Action input undeclared-input');
      expect(result.interfaceDiagnostics.join('\n')).toContain('undeclared Action output undeclared-output');
      expect(result.diagnostics.join('\n')).toContain('installer provider revision differs');
    });

    // integration_id: repository-quality-delivery-regression
    test('repository quality workflow scopes branch events and cancels only stale PR runs', () => {
      const workflow = read('.github/workflows/quality-gate.yml');
      expect(workflow).toMatch(/^  push:\n(?:    #.*\n)?    branches: \[main, develop, 'hotfix\/\*\*'\]$/m);
      expect(workflow).toMatch(/^  pull_request:\n    branches: \[main, develop, 'release\/\*\*', 'hotfix\/\*\*'\]$/m);
      expect(workflow).toMatch(/^  group: quality-gate-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| format\('run-\{0\}', github\.run_id\) \}\}$/m);
      expect(workflow).toMatch(/^  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
    });

    // integration_id: repository-quality-delivery-regression
    test('repository quality workflow keeps the required hosted check behind Linux and Windows evidence', () => {
      const workflow = read('.github/workflows/quality-gate.yml');
      const linux = jobBlock(workflow, 'contract-linux');
      const windows = jobBlock(workflow, 'rust-windows');
      const installerLinux = jobBlock(workflow, 'installer-linux');
      const installerWindows = jobBlock(workflow, 'installer-windows');
      const installerWindowsNative = jobBlock(workflow, 'installer-windows-native');
      const installerMacos = jobBlock(workflow, 'installer-macos');
      const installerHandoff = jobBlock(workflow, 'installer-handoff');
      const aggregate = jobBlock(workflow, 'contract');
      expect(linux).toMatch(/^    name: CI Action contract \/ Linux$/m);
      includesAll(windows, [
        /^    name: Rust release contract \/ Windows$/m,
        /^    runs-on: windows-2025$/m,
        /--testNamePattern="PowerShell\|Windows"/,
      ]);
      includesAll(installerWindows, [
        /^    name: Installer contract \/ Windows$/m,
        /^    runs-on: windows-2025$/m,
        /actions\/setup-python@[0-9a-f]{40}/,
        /python-version: '3\.11'/,
      ]);
      // The native PowerShell checks do not feed the handoff, so they run in their own job and do not delay it.
      includesAll(installerWindowsNative, [
        /^    name: Installer native safety \/ Windows$/m,
        /^    runs-on: windows-2025$/m,
        /actions\/setup-python@[0-9a-f]{40}/,
        /python-version: '3\.11'/,
        /python -m unittest discover -s runtime\/installer\/tests -p test_build_installer\.py -v/,
        /python -m unittest discover -s runtime\/installer\/tests -p test_runtime_installer\.py -k test_windows -v/,
        /name: Test native Windows installer safety \/ Windows PowerShell 5\.1\n\s+shell: powershell\n\s+env:\n\s+CI_INSTALLER_POWERSHELL: powershell/,
        /name: Test native Windows installer safety \/ PowerShell 7\n\s+shell: pwsh\n\s+env:\n\s+CI_INSTALLER_POWERSHELL: pwsh/,
      ]);
      expect(installerWindowsNative).not.toMatch(/npm ci|actions\/setup-node|upload-artifact/);
      expect(installerWindows).not.toContain('Test native Windows installer safety');
      for (const native of [installerWindows, installerMacos]) {
        expect(native).toContain('npm test -- actions/ci-release-supplemental-asset/tests/standard-installer.test.ts');
        expect(native).toContain('npm ci --ignore-scripts --no-audit --no-fund');
        includesAll(stepContaining(native, '- name: Upload installer platform evidence'), [
          /name: installer-platform-\$\{\{ runner\.os \}\}/,
          /path: tests\/tmp\/installer-platform-acceptance/,
          /include-hidden-files: true/,
          /if-no-files-found: error/,
        ]);
      }
      includesAll(installerMacos, [
        /^    runs-on: macos-15$/m,
        /test "\$\(uname -m\)" = arm64/,
        /python3 -m unittest discover -s runtime\/installer\/tests -p 'test_\*\.py' -v/,
      ]);
      includesAll(installerLinux, [
        /node tests\/coverage-tools\/measure-installer-coverage\.mjs report "\$A3_CI_INSTALLER_COVERAGE_OUTPUT"/,
        /name: installer-python-source-coverage/,
        /if-no-files-found: error/,
      ]);
      expect(installerLinux.indexOf('name: Set up Python source coverage tool')).toBeLessThan(installerLinux.indexOf('name: Test installer regression with source coverage'));
      const sourceStep = stepContaining(linux, '- name: Verify all bundled Action sources');
      const installerStep = stepContaining(installerLinux, '- name: Test installer regression with source coverage');
      const reportStep = stepContaining(installerLinux, '- name: Report installer Python source coverage');
      for (const step of [installerStep, reportStep]) expect(step).toContain('A3_CI_INSTALLER_COVERAGE_OUTPUT: tests/tmp/coverage/installer/run-${{ github.run_id }}-${{ github.run_attempt }}');
      expect(sourceStep).toContain('node runtime/repository/verify-action-packages.mjs --scope=actions');
      expect(installerStep).toContain('npm test -- runtime/installer/tests/common-regression.test.mjs');
      expect(linux).not.toContain('measure-installer-coverage.mjs');
      expect(linux).not.toContain('common-regression.test.mjs');
      const reporter = stepContaining(installerLinux, '- name: Test contract-subject coverage reporter');
      expect(reporter).toContain('npm --prefix tests/coverage-tools ci --ignore-scripts --no-audit --no-fund');
      expect(reporter).toContain('npm test -- tests/contract-subject-execution.test.mjs runtime/repository/tests/contract-coverage-aggregation.test.mjs');
      expect(reporter).not.toMatch(/continue-on-error|if:/);
      expect(linux).not.toContain('Test contract-subject coverage reporter');
      expect(reportStep).not.toContain('test:coverage:installer');
      expect(new Set(summaryNeeds(aggregate))).toStrictEqual(new Set(['contract-linux', 'installer-linux', 'rust-windows', 'installer-windows', 'installer-windows-native', 'installer-macos', 'installer-handoff']));
      expect(aggregate).toContain('INSTALLER_LINUX_RESULT: ${{ needs.installer-linux.result }}');
      expect(aggregate).toContain('test "$INSTALLER_LINUX_RESULT" = success');
      const diagnostics = stepContaining(linux, '- name: Test failure diagnostics');
      for (const file of ['runtime/diagnostics/tests/failure.test.mjs', 'tests/action-failure-diagnostics.test.mjs', 'tests/runtime-failure-diagnostics.test.mjs', 'tests/workflow-failure-diagnostics.test.mjs']) {
        expect(diagnostics).toContain(file);
      }
      expect(diagnostics).not.toMatch(/continue-on-error|if:/);
      const cores = stepContaining(linux, '- name: Test shared verification cores');
      for (const file of ['runtime/github-toolchain/tests/verify-github-toolchain.test.mjs', 'runtime/path/tests/same-file-core.test.mjs', 'runtime/platform/tests/platform-manifest-core.test.mjs', 'runtime/vitest/tests/vitest-report-core.test.mjs']) {
        expect(cores).toContain(file);
        expect(linux.split(file)).toHaveLength(2);
      }
      includesAll(installerHandoff, [
        /producer: contract-linux/,
        /name: installer-platform-\$\{\{ matrix\.platform \}\}/,
        /CI_INSTALLER_PLATFORM_INPUT: tests\/tmp\/installer-platform-acceptance/,
        /-t 'revalidates downloaded platform evidence'/,
        /needs: \[contract-linux, installer-windows, installer-macos\]/,
        /producer: installer-windows/,
        /producer: installer-macos/,
        /uses: \.\/actions\/ci-handoff-integrity/,
        /source-sha: \$\{\{ needs\[matrix\.producer\]\.outputs\.source-sha \}\}/,
      ]);
      includesAll(aggregate, [
        /^    name: CI Action contract \/ hosted$/m,
        /^    if: always\(\)$/m,
        /test "\$LINUX_RESULT" = success/,
        /test "\$WINDOWS_RESULT" = success/,
        /test "\$INSTALLER_WINDOWS_RESULT" = success/,
        /test "\$INSTALLER_WINDOWS_NATIVE_RESULT" = success/,
        /test "\$INSTALLER_MACOS_RESULT" = success/,
        /test "\$INSTALLER_HANDOFF_RESULT" = success/,
        /INSTALLER_MACOS_RESULT: \$\{\{ needs\.installer-macos\.result \}\}/,
        /INSTALLER_WINDOWS_RESULT: \$\{\{ needs\.installer-windows\.result \}\}/,
        /INSTALLER_WINDOWS_NATIVE_RESULT: \$\{\{ needs\.installer-windows-native\.result \}\}/,
      ]);
    });

    // integration_id: repository-quality-delivery-regression
    test('repository CI runs every Vitest file the root configuration collects', () => {
      // Arrange
      const collected = globSync(vitestConfig.test.include, { cwd: root });
      const workflowTests = ['.github/workflows/quality-gate.yml', '.github/workflows/release.yml']
        .flatMap((file) => read(file).match(/[\w./-]+\.test\.(?:ts|mjs)/g) ?? []);
      const planTests = [...verificationPlan(collectActionPackages(root)), ...sharedRuntimeVerificationPlan(root)]
        .filter((step) => step.phase === 'test')
        .flatMap((step) => step.args.filter((arg) => /\.test\.(?:ts|mjs)$/.test(arg)).map((arg) => path.relative(root, arg)));
      // Act
      const selected = new Set([...workflowTests, ...planTests]);
      // Assert
      expect(collected.filter((file) => !selected.has(file))).toStrictEqual([]);
    });

    test('repository CI discovers every tracked Python test file', () => {
      // Arrange
      const collected = execFileSync('git', ['ls-files', '-z', '--', '*test*.py'], { cwd: root, encoding: 'utf8' })
        .split('\0').filter((file) => /^test.*\.py$/.test(path.basename(file)));
      const discovers = ['.github/workflows/quality-gate.yml', '.github/workflows/release.yml']
        .flatMap((file) => [...read(file).matchAll(/unittest discover -s (\S+)(?: -p (\S+))?/g)])
        .map(([, start, pattern]) => ({ start, pattern: pattern?.replace(/^'|'$/g, '') ?? 'test*.py' }));
      // Act
      const undiscovered = collected.filter((file) => !discovers.some(({ start, pattern }) =>
        path.dirname(file) === start && path.matchesGlob(path.basename(file), pattern)));
      // Assert
      expect(undiscovered).toStrictEqual([]);
    });

    // integration_id: repository-quality-delivery-regression
    test('provider reference gate rejects first-party binding drift', () => {
      // Arrange
      const binding = { repository: 'a3-suite/a3-ci-github', exactRef: actionRef };
      const workflow = yaml.stringify({ jobs: { verify: { steps: [{ uses: `a3-suite/a3-ci-github/actions/ci-quality-adapter@${'f'.repeat(40)}` }] } } });
      // Act
      const diagnostics = checkProviderReferences(workflow, '.github/workflows/ci-quality.yml', new Map(), binding);
      // Assert
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain('first-party');
    });

    // integration_id: repository-quality-delivery-regression
    test('repository gate Action steps match their action.yml inputs', () => {
      const job = jobBlock(read('.github/workflows/quality-gate.yml'), 'contract-linux');
      const actionInputs = (name) => {
        const inputsSection = read(`actions/${name}/action.yml`).split(/^inputs:\s*$/m)[1];
        if (!inputsSection) return [];
        return inputsSection.split(/^\S/m)[0]
          .split(/^  (?=[a-zA-Z0-9_-]+:)/m)
          .filter((entry) => /^([a-zA-Z0-9_-]+):/.test(entry))
          .map((entry) => ({
            name: entry.match(/^([a-zA-Z0-9_-]+):/)[1],
            required: /^    required:\s*true\s*$/m.test(entry),
          }));
      };
      let checked = 0;
      let direct = 0;
      for (const step of job.split('\n      - ').slice(1)) {
        const useMatch = step.match(/^        uses: \.\/actions\/([a-zA-Z0-9_-]+)$/m);
        const runMatch = step.match(/\bnode actions\/([a-zA-Z0-9_-]+)\/dist\/index\.js\b/);
        const action = useMatch?.[1] ?? runMatch?.[1];
        if (!action) continue;
        const stepName = step.match(/^        name: (.+)$/m)?.[1] ?? action;
        const declared = actionInputs(action);
        const provided = useMatch
          ? [...(step.split(/^        with:\s*$/m)[1] ?? '').split(/^        \S/m)[0]
              .matchAll(/^          ([a-zA-Z0-9_-]+):/gm)].map((match) => match[1])
          : [...(step.split(/^        env:\s*$/m)[1] ?? '').split(/^        \S/m)[0]
              .matchAll(/^          INPUT_([A-Z0-9_-]+):/gm)].map((match) => match[1].toLowerCase());
        const declaredNames = declared.map((input) => input.name);
        for (const input of provided) {
          expect(declaredNames.includes(input), `${stepName} passes undeclared input ${input} to ${action}`).toBeTruthy();
        }
        for (const input of declared) {
          if (input.required) {
            expect(provided.includes(input.name), `${stepName} omits required input ${input.name} of ${action}`).toBeTruthy();
          }
        }
        if (runMatch) direct += 1;
        checked += 1;
      }
      expect(checked > 0, 'expected the repository gate to use local Action steps').toBeTruthy();
      expect(direct > 0, 'expected the repository gate to validate direct Action invocations').toBeTruthy();
    });

    // integration_id: repository-quality-delivery-regression
    test('canonical workflow summaries cover exactly their needs jobs', () => {
      const workflows = [
        ['workflows/release/release-request-tag.yml', 'summary'],
        ['workflows/quality/quality-gate.yml', 'summary'],
        ['workflows/quality/quality-gate-platforms.yml', 'platform-summary'],
        ['.github/workflows/ci-quality.yml', 'summary'],
        ['workflows/release/release-publication-caller.yml', 'summary'],
        ['.github/workflows/ci-release-publication.yml', 'summary'],
        ['workflows/package/package-publication-caller.yml', 'summary'],
        ['.github/workflows/ci-package-preparation.yml', 'summary'],
        ['.github/workflows/ci-package-publication.yml', 'summary'],
      ];
      for (const [relative, summaryId] of workflows) {
        const summary = jobBlock(read(relative), summaryId);
        const needs = summaryNeeds(summary);
        const rows = [...summary.matchAll(/"rawResult":"\$\{\{ needs\.([a-zA-Z0-9_-]+)\.result \}\}"/g)]
          .map(([, job]) => job);
        expect([...rows].sort(), `${relative} summary rows must match needs`).toStrictEqual([...needs].sort());
        expect(new Set(rows).size, `${relative} summary rows must be unique`).toBe(rows.length);
      }
    });
  });
});


describe("workflow-contracts", () => {
  describe("failure-diagnostics-contract", () => {
    // contract_id: contract.ci-failure-diagnostics.subject-declarations
    // integration_id: failure-diagnostics-contract
    // evidence_role: contract
    // test_level: integration
    test('every packaged contract defines subject-specific diagnostics under the shared minimum', () => {
      // Arrange
      const base = 'sdd/dsl/specs/contract-core';
      const packageData = yaml.parse(read(`${base}/contract-package.sdd.yml`));
      const diagnosticPartition = 'runtime-context.failure-diagnostic-required';
      const shared = yaml.parse(read(`${base}/subjects/ci-failure-diagnostics/subject.sdd.yml`)).contracts[0];
      const commonObservation = shared.observations.find((entry) => entry.boundary.ref === 'boundary.diagnostic-result');
      // Act
      const subjects = packageData.subject_scopes.map((scope) => ({
        ...yaml.parse(read(`${base}/${scope.path}subject.sdd.yml`)),
        verifications: yaml.parse(read(`${base}/${scope.path}verifications.sdd.yml`)),
      }));
      // Assert
      const commonSelectors = commonObservation.value.fields.map((field) => field.selector);
      const minimumFields = [
        'failure-subject', 'failure-operation', 'failure-stage', 'failure-reason', 'failure-cause', 'execution-context',
        'comparison', 'evidence-location', 'execution-outcome', 'last-confirmed-stage', 'next-check-rule',
      ];
      expect(commonSelectors).toEqual(expect.arrayContaining(minimumFields));
      const policyClaims = shared.guarantees.filter((guarantee) => 'in' in guarantee.claim && guarantee.claim.in.includes('absent'));
      expect(policyClaims.length).toBeGreaterThan(0);
      for (const guarantee of policyClaims) {
        expect(guarantee.claim.in).toStrictEqual(['absent']);
        expect(commonSelectors).toContain(guarantee.claim.field);
      }
      for (const subject of subjects) {
        if (subject.subject.id === 'subject.ci.failure-diagnostics') {
          expect(shared.guarantees.filter((entry) => entry.applies_to.includes(diagnosticPartition))).toHaveLength(minimumFields.length + policyClaims.length);
          continue;
        }
        for (const contract of subject.contracts) {
          const guarantee = contract.guarantees.find((entry) => entry.claim.field === 'failure-stage');
          expect(guarantee, contract.id).toBeDefined();
          expect(guarantee.claim.present, contract.id).toBe(true);
          expect(guarantee.applies_to, contract.id).toContain(diagnosticPartition);
          const observation = contract.observations.find((entry) => entry.value.fields.some((field) => field.selector === 'failure-stage'));
          expect(observation.boundary.ref, contract.id).toBe('boundary.diagnostic-result');
          expect(observation.summary, contract.id).toContain(shared.id);
          const failureCase = subject.verifications.cases.find((entry) => entry.contract_id === contract.id && entry.partition === diagnosticPartition);
          expect(failureCase, contract.id).toBeDefined();
          expect(failureCase.verifies ?? [guarantee.id], contract.id).toContain(guarantee.id);
        }
      }
    });

    // contract_id: contract.ci-failure-diagnostics.workflow-evidence
    // integration_id: failure-diagnostics-contract
    test('managed workflows expose correlated secret-safe failure evidence without hiding source results', () => {
      const workflows = [
        ['workflows/release/release-request-tag.yml', 'summary'],
        ['workflows/quality/quality-gate.yml', 'summary'],
        ['.github/workflows/ci-quality.yml', 'summary'],
        ['workflows/quality/quality-gate-platforms.yml', 'platform-summary'],
        ['.github/workflows/ci-quality-platforms.yml', 'platform-summary'],
        ['workflows/release/release-publication-caller.yml', 'summary'],
        ['.github/workflows/ci-release-publication.yml', 'summary'],
        ['workflows/package/package-publication-caller.yml', 'summary'],
        ['.github/workflows/ci-package-preparation.yml', 'summary'],
        ['.github/workflows/ci-package-publication.yml', 'summary'],
      ];
      for (const [relative, summaryId] of workflows) {
        const summary = jobBlock(read(relative), summaryId);
        includesAll(summary, [
          /^    if: always\(\)$/m,
          /ci-quality-summary@/,
          /"reason"/,
        ]);
        expect(summary).not.toMatch(/secrets(?:\.|\s*\[)/);

        if (summaryId === 'platform-summary' && relative === '.github/workflows/ci-quality-platforms.yml') {
          includesAll(summary, [
            /^      WORKFLOW_RUN_URL: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}$/m,
            /^      RESOLVE_RESULT: \$\{\{ needs\.resolve-platforms\.result \}\}$/m,
            /^      PLATFORM_RESULT: \$\{\{ needs\.platform\.result \}\}$/m,
            /elif \[\[ "\$\{RESOLVE_RESULT:-\}" == "success" && "\$\{PLATFORM_RESULT:-\}" == "success" \]\]; then\n\s+result="success"/,
            /elif \[\[ "\$\{PLATFORM_RESULT:-\}" == "failure" \|\| "\$\{RESOLVE_RESULT:-\}" == "failure" \]\]; then\n\s+result="failed"/,
            /elif \[\[ "\$\{PLATFORM_RESULT:-\}" == "cancelled" \|\| "\$\{PLATFORM_RESULT:-\}" == "skipped" \]\]; then\n\s+result="未実施"/,
            /else\n\s+result="判定不能"/,
            /"evidence": os\.environ\["EVIDENCE"\]/,
            /"reason": os\.environ\["REASON"\]/,
          ]);
          continue;
        }

        for (const sourceJob of summaryNeeds(summary)) {
          const record = unitRecord(summary, sourceJob);
          const escapedJob = sourceJob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // The row passes the raw GitHub job result and caller-owned applicability;
          // failed and missing states are normalized by the ci-quality-summary contract.
          expect(record).toMatch(new RegExp(`"rawResult":"\\$\\{\\{ needs\\.${escapedJob}\\.result \\}\\}"`));
          expect(record).toMatch(/"applicable":/);
          // ci-quality-summary fills the run URL when a row omits evidence.
          expect(record).not.toMatch(/"evidence"/);
          expect(record).toMatch(new RegExp(`"reason":"[^"]*needs\\.${escapedJob}\\.result`));
        }
      }
    });
  });
});


describe("workflow-contracts", () => {
  describe("quality-workflow-contract", () => {
    // integration_id: quality-workflow-contract
    test('quality toolchain callers bind four inputs and preserve execution gates', () => {
      const pairs = [['.github/workflows/ci-quality.yml', 'trusted'], ['.github/workflows/ci-quality.yml', 'untrusted-pr'], ['.github/workflows/ci-quality-platforms.yml', 'platform'], ['.github/workflows/ci-release-publication.yml', 'quality']];
      const contract = yaml.parse(read('actions/ci-quality-toolchain/action.yml'));
      for (const [file, jobId] of pairs) {
        const workflow = yaml.parse(read(file));
        const job = workflow.jobs[jobId];
        const call = job.steps.filter((step) => step.uses?.includes('/actions/ci-quality-toolchain@'));
        expect(call.length, file).toBe(1);
        expect(call[0].uses).toBe(`a3-suite/a3-ci-github/actions/ci-quality-toolchain@${actionRef}`);
        const expected = { 'language-profile': '${{ env.CI_LANGUAGE_PROFILE }}', 'toolchain-version': '${{ env.CI_TOOLCHAIN_VERSION }}', 'uv-version': '${{ env.CI_UV_VERSION }}', 'cargo-audit-version': '${{ env.CI_CARGO_AUDIT_VERSION }}', ...(call[0].with['version-policy'] !== undefined ? { 'version-policy': file.includes('ci-quality.yml') ? 'compatible' : 'exact' } : {}) };
        expect(call[0].with).toStrictEqual(expected);
        expect(contract.inputs['version-policy'].default).toBe('exact');
        expect(call[0].if).toBe(file.includes('ci-quality.yml') ? "steps.change-scope.outputs['run-ci'] != 'false'" : undefined);
        expect(call[0]['continue-on-error']).toBe(undefined);
        expect(job.steps.some((step) => step.uses?.includes('/actions/ci-quality-adapter@'))).toBeTruthy();
        expect(job.steps.every((step) => step.name !== 'Report project quality adapter result' && !step.env?.CI_QUALITY_RESULT_PATH)).toBeTruthy();
        expect(!job.steps.some((step) => step.run?.includes('rustup toolchain install') || step.uses?.startsWith('actions/setup-node@') || step.uses?.startsWith('actions/setup-python@') || step.uses?.startsWith('astral-sh/setup-uv@'))).toBeTruthy();
      }
    });

    // integration_id: quality-workflow-contract
    test('quality ranges resolve once and exact versions propagate to adapters and platform jobs', () => {
      const main = yaml.parse(read('.github/workflows/ci-quality.yml'));
      for (const id of ['trusted', 'untrusted-pr']) {
        const steps = main.jobs[id].steps;
        expect(steps.find(step => step.id === 'quality-toolchain').with['version-policy']).toBe('compatible');
        expect(steps.find(step => step.id === 'quality-adapter').with['toolchain-version']).toBe('${{ steps.quality-toolchain.outputs.resolved-toolchain-version }}');
      }
      const jobs = yaml.parse(read('.github/workflows/ci-quality-platforms.yml')).jobs;
      const resolver = jobs['resolve-platforms'];
      expect(resolver.steps.filter(step => step.id === 'toolchain-resolution')).toHaveLength(1);
      expect(resolver.steps.find(step => step.id === 'toolchain-resolution').if).toContain("steps.configuration.outputs['resolve-toolchain'] == 'true'");
      expect(resolver.outputs['toolchain-version']).toBe("${{ steps.configuration.outputs['resolve-toolchain'] == 'true' && steps.toolchain-resolution.outputs.resolved-toolchain-version || steps.configuration.outputs['toolchain-version'] }}");
      expect(jobs.platform.env.CI_TOOLCHAIN_VERSION).toBe('${{ needs.resolve-platforms.outputs.toolchain-version }}');
      expect(jobs.platform.steps.find(step => step.uses?.includes('/ci-quality-toolchain@')).with['version-policy']).toBeUndefined();
      const release = yaml.parse(read('.github/workflows/ci-release-publication.yml')).jobs;
      expect(release.quality.steps.find(step => step.uses?.includes('/ci-quality-toolchain@')).with['version-policy']).toBeUndefined();
      expect(release.authority.steps.find(step => step.id === 'platform-matrix').with['runner-policy']).toBe('trusted');
    });
  });
});
