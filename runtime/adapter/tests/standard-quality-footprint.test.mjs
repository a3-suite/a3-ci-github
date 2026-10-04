import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';
import { materializeAdapterBundle } from '../materialize-adapter-bundle.ts';
import { standardQualityBundle } from '../standard-quality-bundles.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const skillRoot = process.env.A3_CI_GITHUB_QUALITY_SKILL_ROOT;
const require = createRequire(import.meta.url);
const yaml = require(path.join(root, 'runtime/preset/node_modules/yaml'));
const inventoryPath = 'skills/ci-github/references/ci-script-assets.reference.yml';
const filesIn = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);

describe("adapter-bundle-materialization-contract", () => {
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
          expect(bundle, `unregistered standard profile: ${profile}`).toBeTruthy();
          const source = skillRoot ? path.join(skillRoot, bundle.source.skill, bundle.source.path) : undefined;
          const original = standardQualityBundle(bundle.id).descriptor;
          const ownerBefore = source ? fs.readFileSync(source, 'utf8') : undefined;
          const descriptor = yaml.parse(original);
          expect(descriptor.assets, `${profile} unexpectedly requires common scripts`).toStrictEqual([]);
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
          expect(materializeAdapterBundle({ ...options,
            sourceRoot: skillRoot ?? path.join(fixture, 'unavailable-owner-collection') })).toStrictEqual(report);
          const cli = spawnSync(process.execPath, [
            '--import', require.resolve('tsx', { paths: [path.join(root, 'runtime/preset')] }),
            path.join(root, 'runtime/adapter/materialize-adapter-bundle.ts'),
            '--inventory', inventoryPath, '--bundle', bundle.id, '--target-root', project,
          ], { encoding: 'utf8', cwd: root });
          expect(cli.status, cli.stderr).toBe(0);
          expect(JSON.parse(cli.stdout)).toStrictEqual(report);
          expect(report.schema).toBe('ci.adapter-materializer.v1');
          expect(report.files).toStrictEqual([]);
          expect(report.descriptor).toBe('');
          expect(report.binding.standardBundleId).toBe(bundle.id);
          expect(filesIn(project).filter((file) => !before.has(file))).toStrictEqual([]);
          for (const [file, bytes] of before) expect(fs.readFileSync(file)).toStrictEqual(bytes);
          if (source) expect(fs.readFileSync(source, 'utf8')).toBe(ownerBefore);
          expect(materializeAdapterBundle(options)).toStrictEqual(report);
          expect(() => materializeAdapterBundle({ ...options, outputPath: path.join(project, 'README.md') })).toThrow(/output-conflict/);
          expect(fs.readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('consumer-owned documentation\n');
          const danglingOutput = path.join(project, 'report-link');
          fs.symlinkSync('missing-report.json', danglingOutput);
          expect(() => materializeAdapterBundle({ ...options, outputPath: danglingOutput })).toThrow(/output-conflict/);
          expect(fs.existsSync(path.join(project, 'missing-report.json'))).toBe(false);
          if (descriptor.projectSettings.requiredScripts.length > 0) {
            fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: {} }));
            expect(() => materializeAdapterBundle(options)).toThrow(/project-script/);
          }
        }
      } finally {
        if (previousRuntimeRoot === undefined) delete process.env.CI_FIXED_RUNTIME_ROOT;
        else process.env.CI_FIXED_RUNTIME_ROOT = previousRuntimeRoot;
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });
});
