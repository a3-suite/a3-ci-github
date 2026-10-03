import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { materializeAdapterBundle } from '../materialize-adapter-bundle.ts';
import { standardQualityBundle } from '../standard-quality-bundles.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const skillRoot = process.env.A3_CI_GITHUB_QUALITY_SKILL_ROOT;
const require = createRequire(import.meta.url);
const yaml = require(path.join(root, 'runtime/preset/node_modules/yaml'));
const inventoryPath = 'skills/ci-github/references/ci-script-assets.reference.yml';
const filesIn = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);

// integration_id: adapter-bundle-materialization-contract
test('registered standard quality bundles require no consumer copies and preserve consumer files', () => {
    const inventory = yaml.parse(fs.readFileSync(path.join(root, inventoryPath), 'utf8'));
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const fixture = fs.mkdtempSync(path.join(root, 'tmp', 'standard-quality-footprint-'));
    const previousRuntimeRoot = process.env.CI_FIXED_RUNTIME_ROOT;
    process.env.CI_FIXED_RUNTIME_ROOT = path.join(root, 'runtime/preset');
    try {
      for (const profile of ['rust', 'python', 'typescript']) {
        const bundle = inventory.adapterBundles.find((item) => item.languageProfiles.includes(profile));
        assert.ok(bundle, `unregistered standard profile: ${profile}`);
        const source = skillRoot ? path.join(skillRoot, bundle.source.skill, bundle.source.path) : undefined;
        const original = standardQualityBundle(bundle.id).descriptor;
        const ownerBefore = source ? fs.readFileSync(source, 'utf8') : undefined;
        const descriptor = yaml.parse(original);
        assert.deepEqual(descriptor.assets, [], `${profile} unexpectedly requires common scripts`);
        const project = path.join(fixture, profile);
        fs.mkdirSync(project);
        fs.writeFileSync(path.join(project, 'README.md'), 'consumer-owned documentation\n');
        for (const file of descriptor.projectSettings.requiredFiles) {
          const destination = path.join(project, file);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, file === 'package.json'
            ? JSON.stringify({ scripts: Object.fromEntries(descriptor.projectSettings.requiredScripts
              .map((script) => [script, 'node --version'])) }) : '\n');
        }
        const before = new Map(filesIn(project).map((file) => [file, fs.readFileSync(file)]));
        const options = { inventoryPath, bundleId: bundle.id, targetRoot: project };
        const report = materializeAdapterBundle(options);
        assert.deepEqual(materializeAdapterBundle({ ...options,
          sourceRoot: skillRoot ?? path.join(fixture, 'unavailable-owner-collection') }), report);
        const cli = spawnSync(process.execPath, [
          '--import', require.resolve('tsx', { paths: [path.join(root, 'runtime/preset')] }),
          path.join(root, 'runtime/adapter/materialize-adapter-bundle.ts'),
          '--inventory', inventoryPath, '--bundle', bundle.id, '--target-root', project,
        ], { encoding: 'utf8', cwd: root });
        assert.equal(cli.status, 0, cli.stderr);
        assert.deepEqual(JSON.parse(cli.stdout), report);
        assert.equal(report.schema, 'ci.adapter-materializer.v1');
        assert.deepEqual(report.files, []);
        assert.equal(report.descriptor, '');
        assert.equal(report.binding.standardBundleId, bundle.id);
        assert.deepEqual(filesIn(project).filter((file) => !before.has(file)), []);
        for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
        if (source) assert.equal(fs.readFileSync(source, 'utf8'), ownerBefore);
        assert.deepEqual(materializeAdapterBundle(options), report);
        assert.throws(() => materializeAdapterBundle({ ...options, outputPath: path.join(project, 'README.md') }), /output-conflict/);
        assert.equal(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), 'consumer-owned documentation\n');
        const danglingOutput = path.join(project, 'report-link');
        fs.symlinkSync('missing-report.json', danglingOutput);
        assert.throws(() => materializeAdapterBundle({ ...options, outputPath: danglingOutput }), /output-conflict/);
        assert.equal(fs.existsSync(path.join(project, 'missing-report.json')), false);
        if (descriptor.projectSettings.requiredScripts.length > 0) {
          fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: {} }));
          assert.throws(() => materializeAdapterBundle(options), /project-script/);
        }
      }
    } finally {
      if (previousRuntimeRoot === undefined) delete process.env.CI_FIXED_RUNTIME_ROOT;
      else process.env.CI_FIXED_RUNTIME_ROOT = previousRuntimeRoot;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
