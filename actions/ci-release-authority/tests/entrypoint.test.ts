import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';
import { fixture, source, repository } from './fixture';
import { OWNER_HANDOFF_PATH } from '../src/authority';
import { resolveConfigSnapshot } from '../../ci-config-snapshot/src/snapshot';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

// The output destination is the output directory option; it may not exist yet.
const fileNames = (directory: string): string[] => (fs.existsSync(directory) ? fs.readdirSync(directory, { recursive: true, encoding: 'utf8' }).sort() : []);

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
// flow_id: ci-release-authority-bundle
// contract_id: contract.ci-release-authority.outputs
test('authority entrypoint emits verified outputs and suppresses outputs on rejection', () => {
  for (const invalid of [false, true]) {
    const f = fixture();
    try {
      const responses = path.join(f.root, 'responses.json');
      fs.writeFileSync(responses, JSON.stringify(f.responses));
      const preload = path.join(f.root, 'mock-fetch.mjs');
      fs.writeFileSync(preload, `import fs from 'node:fs';\nconst responses = JSON.parse(fs.readFileSync(process.env.TEST_RESPONSES));\nglobalThis.fetch = async (url, init) => { if (init.method !== 'GET') throw new Error('write-forbidden'); return new Response(JSON.stringify(responses[String(url).replace('https://api.github.com', '')] ?? {}), {status:200}); };\n`);
      const output = path.join(f.root, 'output');
      fs.writeFileSync(output, '');
      const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: output,
        TEST_RESPONSES: responses, 'INPUT_ROOT-DIRECTORY': f.root, 'INPUT_SNAPSHOT-PATH': 'snapshot.json', 'INPUT_OUTPUT-DIRECTORY': f.options.outputDirectory,
        'INPUT_RELEASE-REQUEST-RUN-ID': '11', 'INPUT_PUBLICATION-REQUEST-RUN-ID': '22', 'INPUT_GITHUB-TOKEN': invalid ? '' : 'synthetic-secret' };
      const filesBefore = fileNames(f.options.outputDirectory);
      const result = spawnSync(process.execPath, ['--import', preload, ...entrypointArgs], { env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(invalid ? 1 : 0);
      expect(result.stderr.includes('synthetic-secret')).toBe(false);
      const bytes = fs.readFileSync(output, 'utf8');
      if (invalid) { expect(bytes).toBe(''); expect(fs.existsSync(f.options.outputDirectory)).toBe(false); expect(fileNames(f.options.outputDirectory)).toEqual(filesBefore); }
      else { expect(bytes.includes(`source_sha=${source}\n`)).toBeTruthy(); expect(bytes.includes('version=1.2.3\n')).toBeTruthy(); }
    } finally { fs.rmSync(f.root, { recursive: true }); }
  }
});

// Each run serves the fixture responses through a preload that records every request method.
const runAuthority = (entrypointArgs: string[], f: ReturnType<typeof fixture>, outputWritable = true) => {
  const responses = path.join(f.root, 'responses.json');
  const methods = path.join(f.root, 'methods.txt');
  fs.writeFileSync(responses, JSON.stringify(f.responses));
  fs.writeFileSync(methods, '');
  const preload = path.join(f.root, 'mock-fetch.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';\nconst responses = JSON.parse(fs.readFileSync(process.env.TEST_RESPONSES));\nglobalThis.fetch = async (url, init) => { fs.appendFileSync(process.env.TEST_METHODS, (init?.method ?? 'GET') + '\\n'); return new Response(JSON.stringify(responses[String(url).replace('https://api.github.com', '')] ?? {}), {status:200}); };\n`);
  const output = path.join(f.root, 'output');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: outputWritable ? output : f.root,
    TEST_RESPONSES: responses, TEST_METHODS: methods, 'INPUT_ROOT-DIRECTORY': f.root, 'INPUT_SNAPSHOT-PATH': 'snapshot.json', 'INPUT_OUTPUT-DIRECTORY': f.options.outputDirectory,
    'INPUT_RELEASE-REQUEST-RUN-ID': '11', 'INPUT_PUBLICATION-REQUEST-RUN-ID': '22', 'INPUT_GITHUB-TOKEN': 'synthetic-secret' };
  const filesBefore = fileNames(f.options.outputDirectory);
  const result = spawnSync(process.execPath, ['--import', preload, ...entrypointArgs], { env, encoding: 'utf8' });
  const filesAfter = fileNames(f.options.outputDirectory);
  const authorityPath = path.join(f.options.outputDirectory, 'authority.json');
  const outputs = fs.readFileSync(output, 'utf8');
  if (result.status === 0) {
    expect(Object.fromEntries(outputs.trimEnd().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))).toStrictEqual({
      'authority-path': authorityPath,
      source_sha: source,
      version: '1.2.3',
      target_identity: 'platform-set',
      'approval-id': 'approved',
      'body-sha256': crypto.createHash('sha256').update('# Approved release\n').digest('hex'),
    });
    expect(fs.existsSync(authorityPath)).toBe(true);
  }
  return {
    result,
    filesBefore,
    filesAfter,
    outputs,
    methods: fs.readFileSync(methods, 'utf8').split('\n').filter(Boolean),
    authority: () => JSON.parse(fs.readFileSync(authorityPath, 'utf8')),
    authorityExists: () => fs.existsSync(authorityPath),
  };
};
const rewriteSnapshot = (f: ReturnType<typeof fixture>, values: Record<string, string>) => {
  const snapshotPath = path.join(f.root, 'snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  fs.writeFileSync(snapshotPath, JSON.stringify(resolveConfigSnapshot({ workflow: { ...snapshot.values, ...values } })));
};

// contract_id: contract.ci-release-authority.outputs
test('authority entrypoint binds explicit decision, owner workflow and snapshot through GET-only observations', () => {
  // Arrange
  const f = fixture();
  try {
    // Act
    const run = runAuthority(entrypointArgs, f);
    // Assert
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.outputs).toMatch(/^authority-path=.+$/m);
    expect(run.methods.length).toBeGreaterThan(0);
    expect(new Set(run.methods)).toStrictEqual(new Set(['GET']));
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

// contract_id: contract.ci-release-authority.outputs
test('authority entrypoint accepts canonical repository casing while preserving approved identity', () => {
  // Arrange
  const f = fixture();
  try {
    (f.responses[`/repos/${repository}`] as Record<string, unknown>).full_name = repository.toUpperCase();
    for (const id of ['11', '22']) {
      const run = f.responses[`/repos/${repository}/actions/runs/${id}`] as Record<string, Record<string, unknown>>;
      run.repository.full_name = repository.toUpperCase();
    }
    // Act
    const run = runAuthority(entrypointArgs, f);
    // Assert
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.outputs).toMatch(/^authority-path=.+$/m);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

// evidence_role: supplemental
// The content of the authority file is an implementation detail of the handoff that no contract guarantee covers.
test('authority entrypoint writes the approved identity into the authority file', () => {
  // Arrange
  const f = fixture();
  try {
    // Act
    const run = runAuthority(entrypointArgs, f);
    // Assert
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.authority()).toMatchObject({ version: '1.2.3', owner_contract: { id: 'git.release-flow' },
      publication: { source_sha: source, target_identity: 'platform-set', repository } });
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

// evidence_role: supplemental
// The repository casing preserved in the authority file is an implementation detail of the handoff that no contract guarantee covers.
test('authority entrypoint preserves the canonical repository casing in the authority file', () => {
  // Arrange
  const f = fixture();
  try {
    (f.responses[`/repos/${repository}`] as Record<string, unknown>).full_name = repository.toUpperCase();
    for (const id of ['11', '22']) {
      const run = f.responses[`/repos/${repository}/actions/runs/${id}`] as Record<string, Record<string, unknown>>;
      run.repository.full_name = repository.toUpperCase();
    }
    // Act
    const run = runAuthority(entrypointArgs, f);
    // Assert
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.authority().publication.repository).toBe(repository);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

// contract_id: contract.ci-release-authority.outputs
test('authority entrypoint binds the LF platform manifest digest for CRLF and mixed checkouts', () => {
  for (const endings of ['crlf', 'mixed']) {
    // Arrange
    const f = fixture();
    try {
      const filename = path.join(f.root, '.ci/platform-manifest.yml');
      const lf = fs.readFileSync(filename, 'utf8');
      fs.writeFileSync(filename, endings === 'crlf' ? lf.replaceAll('\n', '\r\n') : lf.replace('\n', '\r\n'));
      // Act
      const run = runAuthority(entrypointArgs, f);
      // Assert
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.authority().platform_manifest_sha256).toBe(crypto.createHash('sha256').update(lf).digest('hex'));
    } finally { fs.rmSync(f.root, { recursive: true }); }
  }
});

// contract_id: contract.ci-release-authority.outputs
test('authority entrypoint rejects an expired approval without authority output', () => {
  // Arrange
  const f = fixture();
  try {
    const file = path.join(f.root, 'release-publication-request/request.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.approvalExpiresAt = '2000-01-01T00:00:00Z';
    const bytes = JSON.stringify(value);
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(`${file}.sha256`, `${crypto.createHash('sha256').update(bytes).digest('hex')}  request.json\n`);
    // Act
    const run = runAuthority(entrypointArgs, f);
    // Assert
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toMatch(/approval-is-expired/);
    expect(run.outputs).toBe('');
    expect(run.authorityExists()).toBe(false);
    expect(run.filesAfter).toEqual(run.filesBefore);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

// contract_id: contract.ci-release-authority.outputs
// flow_id: ci-release-authority-bundle
test.each([
  { label: 'an invalid publication decision', stage: 'decision-validation', mutate: (f: ReturnType<typeof fixture>) => {
    const file = path.join(f.root, 'release-publication-request/request.json'); const value = JSON.parse(fs.readFileSync(file, 'utf8')); value.schema = 'ci.release-publication-request.v1'; fs.writeFileSync(file, JSON.stringify(value));
  } },
  { label: 'a missing notes approval', stage: 'notes-approval', mutate: (f: ReturnType<typeof fixture>) => { fs.unlinkSync(path.join(f.root, 'release-notes-handoff/release-notes-approval.json')); } },
  { label: 'a different repository identity', stage: 'repository-identity', mutate: (f: ReturnType<typeof fixture>) => { (f.responses[`/repos/${repository}`] as Record<string, unknown>).full_name = 'another/repository'; } },
  { label: 'a moved release tag', stage: 'tag-source', mutate: (f: ReturnType<typeof fixture>) => { f.responses[`/repos/${repository}/git/ref/tags/v1.2.3`] = { object: { type: 'tag', sha: 'd'.repeat(40) } }; } },
  { label: 'an untrusted publication request run', stage: 'request-provenance', mutate: (f: ReturnType<typeof fixture>) => { (f.responses[`/repos/${repository}/actions/runs/22`] as Record<string, unknown>).conclusion = 'failure'; } },
  { label: 'owner workflow drift', stage: 'workflow-binding', mutate: (f: ReturnType<typeof fixture>) => { fs.appendFileSync(path.join(f.root, OWNER_HANDOFF_PATH), '# changed\n'); } },
  { label: 'config snapshot drift', stage: 'snapshot-validation', mutate: (f: ReturnType<typeof fixture>) => {
    const file = path.join(f.root, 'snapshot.json'); const value = JSON.parse(fs.readFileSync(file, 'utf8')); value.values.CI_TOOLCHAIN_VERSION = 'changed'; fs.writeFileSync(file, JSON.stringify(value));
  } },
  // A dangling link is not an existing output directory, so the run proceeds until creating the handoff directory fails.
  { label: 'an uncreatable authority handoff', stage: 'authority-write', mutate: (f: ReturnType<typeof fixture>) => {
    fs.symlinkSync(path.join(f.root, 'missing-target'), f.options.outputDirectory);
  } },
])('authority entrypoint rejects $label without authority output', ({ stage, mutate }) => {
  // Arrange
  const f = fixture();
  try {
    mutate(f);
    // Act
    const run = runAuthority(entrypointArgs, f);
    // Assert
    expect(run.result.status).toBe(1);
    expect(run.outputs).toBe('');
    expect(run.authorityExists()).toBe(false);
    const line = run.result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
    expect(JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}').classification?.stage, run.result.stderr).toBe(stage);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

// contract_id: contract.ci-release-authority.outputs
test('authority entrypoint records an asset release without language, toolchain or platform bindings', () => {
  // Arrange
  const f = fixture();
  try {
    rewriteSnapshot(f, { CI_RELEASE_IMPLEMENTATION: 'asset-release', CI_LANGUAGE_PROFILE: '__unset__', CI_TOOLCHAIN_VERSION: '__unset__', CI_PLATFORM_MANIFEST: '__unset__' });
    // Act
    const run = runAuthority(entrypointArgs, f);
    // Assert
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.authority()).toMatchObject({ language_profile: null, toolchain_version: null, platform_manifest: null, platform_manifest_sha256: null, version: '1.2.3' });
    expect(new Set(run.methods)).toStrictEqual(new Set(['GET']));
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

// contract_id: contract.ci-release-authority.outputs
// flow_id: ci-release-authority-bundle
test('authority fails when Action outputs cannot be written', () => {
  const f = fixture();
  try {
    const run = runAuthority(entrypointArgs, f, false);
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain('"stage":"output-write"');
    expect(run.authorityExists()).toBe(true);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

});
