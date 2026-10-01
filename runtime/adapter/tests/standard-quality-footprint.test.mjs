import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { materializeAdapterBundle } from '../materialize-adapter-bundle.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const skillRoot = process.env.A3_CI_GITHUB_QUALITY_SKILL_ROOT;
const require = createRequire(import.meta.url);
const yaml = require(path.join(root, 'runtime/preset/node_modules/yaml'));
const inventoryPath = 'skills/ci-github/references/ci-script-assets.reference.yml';
const filesIn = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);

// integration_id: adapter-bundle-materialization-contract
test('registered standard quality bundles materialize only descriptors and preserve consumer files',
  { skip: skillRoot ? false : 'A3_CI_GITHUB_QUALITY_SKILL_ROOT must name the read-only owner skill collection' }, () => {
    const inventory = yaml.parse(fs.readFileSync(path.join(root, inventoryPath), 'utf8'));
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const fixture = fs.mkdtempSync(path.join(root, 'tmp', 'standard-quality-footprint-'));
    const previousRuntimeRoot = process.env.CI_FIXED_RUNTIME_ROOT;
    process.env.CI_FIXED_RUNTIME_ROOT = path.join(root, 'runtime/preset');
    try {
      for (const profile of ['rust', 'python', 'typescript']) {
        const bundle = inventory.adapterBundles.find((item) => item.languageProfiles.includes(profile));
        assert.ok(bundle, `unregistered standard profile: ${profile}`);
        const source = path.join(skillRoot, bundle.source.skill, bundle.source.path);
        const original = fs.readFileSync(source, 'utf8');
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
        const report = materializeAdapterBundle({ sourceRoot: skillRoot, inventoryPath, bundleId: bundle.id, targetRoot: project });
        assert.equal(report.schema, 'ci.adapter-materializer.v1');
        assert.deepEqual(report.files.map((file) => file.destination), [bundle.targetDescriptor]);
        assert.deepEqual(filesIn(project).filter((file) => !before.has(file)), [path.join(project, bundle.targetDescriptor)]);
        assert.equal(fs.readFileSync(path.join(project, bundle.targetDescriptor), 'utf8'), original);
        for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
        assert.equal(fs.readFileSync(source, 'utf8'), original);
        assert.equal(materializeAdapterBundle({ sourceRoot: skillRoot, inventoryPath, bundleId: bundle.id, targetRoot: project }).files[0].action, 'reused');
        if (descriptor.projectSettings.requiredScripts.length > 0) {
          fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: {} }));
          assert.throws(() => materializeAdapterBundle({ sourceRoot: skillRoot, inventoryPath, bundleId: bundle.id, targetRoot: project }), /project-script/);
        }
      }
    } finally {
      if (previousRuntimeRoot === undefined) delete process.env.CI_FIXED_RUNTIME_ROOT;
      else process.env.CI_FIXED_RUNTIME_ROOT = previousRuntimeRoot;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
