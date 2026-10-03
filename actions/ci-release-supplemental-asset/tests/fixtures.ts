import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { TestContext } from 'vitest';
import type { SupplementalOptionsType } from '../../../runtime/release-publication/supplemental';
import { canonicalJson, sha256 } from '../../../runtime/release-publication/io';

export const fixture = (t: TestContext, body = 'test -z "${GITHUB_OUTPUT-}"\nmkdir -p -- "${!#}"\nprintf "%s\\n" "$@" > "${!#}/arguments"', header = '#!/usr/bin/env bash\nset -euo pipefail\n'): {
  root: string; outputPath: string; options: SupplementalOptionsType;
  configure: (values?: Record<string, string>, authorityChanges?: Record<string, string>) => void;
} => {
  const parent = path.resolve(__dirname, '../../../tests/tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'supplemental-phase-'));
  t.onTestFinished(() => fs.rmSync(root, { force: true, recursive: true }));
  execFileSync('git', ['init', '-q', '--object-format=sha1', root]);
  fs.mkdirSync(path.join(root, '.ci/scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ci/scripts/ci-release-supplemental-asset.sh'), `${header}${body}\n`, { mode: 0o700 });
  execFileSync('git', ['-C', root, 'add', '.ci/scripts/ci-release-supplemental-asset.sh']);
  const tree = execFileSync('git', ['-C', root, 'write-tree'], { encoding: 'utf8' }).trim();
  const sourceSha = execFileSync('git', ['-C', root, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n`, encoding: 'utf8',
  }).trim();
  fs.writeFileSync(path.join(root, '.git/HEAD'), `${sourceSha}\n`);
  for (const directory of ['standard build', 'supplemental build']) {
    fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, directory, 'input'), 'unchanged input');
  }
  const configure = (changes: Record<string, string> = {}, authorityChanges: Record<string, string> = {}): void => {
    const values = {
      CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: 'true',
      CI_SUPPLEMENTAL_RELEASE_ASSET_CONTRACT: 'ci.release-asset-publication-contract#supplementalAsset',
      CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: 'owner.installer',
      CI_SUPPLEMENTAL_RELEASE_ASSET_ADAPTER: '.ci/scripts/ci-release-supplemental-asset.sh', ...changes,
    };
    const sources = {};
    const digest = sha256(Buffer.from(canonicalJson({ sources, values })));
    fs.writeFileSync(path.join(root, 'snapshot.json'), JSON.stringify({ schema: 'ci.config-snapshot.v1', sources, values, digest }));
    fs.writeFileSync(path.join(root, 'authority.json'), JSON.stringify({ source_sha: sourceSha, version: '1.0.0', config_snapshot_digest: digest, ...authorityChanges }));
  };
  configure();
  const outputPath = path.join(root, 'action-output');
  fs.writeFileSync(outputPath, '');
  const options = { operation: 'build-platform', sourceRoot: root, authorityPath: 'authority.json', snapshotPath: 'snapshot.json', standardBuildRoot: 'standard build', outputDirectory: 'new output' };
  return { root, outputPath, options, configure };
};
export const bundle = (f: ReturnType<typeof fixture>, changes: Record<string, string> = {}, entrypointArgs = [path.resolve(__dirname, '../dist/index.js')]): ReturnType<typeof spawnSync> => spawnSync(process.execPath,
  entrypointArgs, {
    cwd: f.root, encoding: 'utf8', env: {
      ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: f.outputPath,
      'INPUT_OPERATION': f.options.operation, 'INPUT_SOURCE-ROOT': f.options.sourceRoot,
      'INPUT_AUTHORITY-PATH': f.options.authorityPath, 'INPUT_SNAPSHOT-PATH': f.options.snapshotPath,
      'INPUT_STANDARD-BUILD-ROOT': f.options.standardBuildRoot,
      'INPUT_SUPPLEMENTAL-BUILD-ROOT': f.options.supplementalBuildRoot ?? '',
      'INPUT_OUTPUT-DIRECTORY': f.options.outputDirectory, ...changes,
    },
  });
