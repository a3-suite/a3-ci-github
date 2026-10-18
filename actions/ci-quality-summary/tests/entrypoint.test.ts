import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';


import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');
const bundledEntrypoint = entrypointArgs;

const runBundled = (
  input: unknown,
  includeSummaryPath = true,
  pathMode: 'distinct' | 'same' | 'hardlink' | 'nested' = 'distinct',
  envOverrides: Record<string, string | undefined> = {},
) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-quality-summary-'));
  const summaryPath = path.join(tempRoot, 'summary.md');
  const evidencePath = pathMode === 'same'
    ? summaryPath
    : pathMode === 'nested'
      ? path.join(tempRoot, 'nested', 'deep', 'evidence.md')
      : path.join(tempRoot, 'evidence.md');
  const outputPath = path.join(tempRoot, 'outputs');
  fs.writeFileSync(outputPath, '', 'utf8');
  if (pathMode === 'hardlink') {
    fs.writeFileSync(summaryPath, '', 'utf8');
    fs.linkSync(summaryPath, evidencePath);
  }
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  delete env['INPUT_SUMMARY-PATH'];
  env.GITHUB_ACTIONS = 'true';
  env.GITHUB_OUTPUT = outputPath;
  env['INPUT_SUMMARY-JSON'] = JSON.stringify(input);
  env['INPUT_EVIDENCE-PATH'] = evidencePath;
  if (includeSummaryPath) env.GITHUB_STEP_SUMMARY = summaryPath;
  for (const [name, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const result = spawnSync(process.execPath, [...bundledEntrypoint], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return {
    tempRoot,
    summaryPath,
    evidencePath,
    outputPath,
    result,
  };
};

const outputValue = (output: string, name: string): string => {
  const match = output.match(new RegExp(`${name}<<[^\\n]+\\n([\\s\\S]*?)\\n[^\\n]+`));
  expect(match, `missing output: ${name}`).toBeTruthy();
  return match![1];
};

const runEnv = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/project', GITHUB_RUN_ID: '42' };
const runUrl = 'https://github.com/owner/project/actions/runs/42';

const successInput = {
  jobs: [{
    unit: 'unit',
    execution: 'test',
    result: 'success',
    evidence: 'evidence.log',
    collection: '完了',
  }],
};

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint writes matching evidence and outputs', () => {
  // Arrange
  const input = successInput;
  // Act
  const run = runBundled(input, true, 'nested');
  try {
    // Assert
    expect(run.result.status).toBe(0);
    const evidence = fs.readFileSync(run.evidencePath, 'utf8');
    expect(evidence).toBe(fs.readFileSync(run.summaryPath, 'utf8'));
    expect(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'digest')).toBe(`sha256:${createHash('sha256').update(evidence, 'utf8').digest('hex')}`);
    expect(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'status')).toBe('success');
    expect(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'evidence-path')).toBe(run.evidencePath);
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint uses the workflow run URL for rows without evidence', () => {
  // Failed rows render their evidence in the details section.
  const run = runBundled({
    jobs: [{ unit: 'build', execution: 'build', rawResult: 'failure', applicable: true }],
    tests: [
      { unit: 'contract', execution: 'node', result: 'failed', collection: '完了', reason: 'assertion failed' },
      { unit: 'explicit', execution: 'node', result: 'failed', evidence: 'explicit.log', collection: '完了', reason: 'assertion failed' },
    ],
  }, true, 'distinct', runEnv);
  try {
    const evidence = fs.readFileSync(run.evidencePath, 'utf8');
    expect(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'status')).toBe('failed');
    expect(evidence.split(runUrl).length - 1).toBe(2);
    expect(evidence).toContain('explicit.log');
    const line = run.result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'))!;
    expect(JSON.parse(line.slice('ci-failure-diagnostic:'.length)).context.inputs.jobs).toEqual([{ unit: 'build', rawResult: 'failure', evidence: runUrl }]);
    const enterprise = runBundled({ jobs: [{ unit: 'build', execution: 'build', rawResult: 'failure', applicable: true }] }, true, 'distinct', { ...runEnv, GITHUB_SERVER_URL: 'https://git.example.com' });
    try {
      const enterpriseLine = enterprise.result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'))!;
      expect(JSON.parse(enterpriseLine.slice('ci-failure-diagnostic:'.length)).context.inputs.jobs[0].evidence).toBe('https://git.example.com/owner/project/actions/runs/42');
    } finally {
      fs.rmSync(enterprise.tempRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint rejects rows without evidence when the run context is missing or invalid', () => {
  const row = { unit: 'build', execution: 'build', rawResult: 'success', applicable: true };
  for (const overrides of [{ GITHUB_RUN_ID: undefined }, { GITHUB_RUN_ID: '42\nINJECTED' }, { GITHUB_SERVER_URL: 'http://github.com' }, { GITHUB_SERVER_URL: 'https://github.com:99999' }, { GITHUB_SERVER_URL: 'https://github.com/path' }, { GITHUB_REPOSITORY: 'owner' }]) {
    const run = runBundled({ jobs: [row] }, true, 'distinct', { ...runEnv, ...overrides });
    try {
      expect(run.result.status, JSON.stringify(overrides)).not.toBe(0);
      expect(run.result.stderr).toContain('ci-summary-evidence-invalid');
      expect(fs.existsSync(run.evidencePath)).toBe(false);
    } finally {
      fs.rmSync(run.tempRoot, { recursive: true, force: true });
    }
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint normalizes a raw GitHub job result', () => {
  const run = runBundled({ jobs: [{
    unit: 'build', execution: 'build', rawResult: 'failure', applicable: true, evidence: 'run',
  }] });
  try {
    expect(run.result.status).not.toBe(0);
    expect(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'status')).toBe('failed');
    expect(fs.readFileSync(run.evidencePath, 'utf8')).toMatch(/job result: failure/);
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint rejects a missing summary path', () => {
  // Arrange
  // Act
  const missingPath = runBundled(successInput, false);
  try {
    // Assert
    expect(missingPath.result.status).not.toBe(0);
    expect(outputValue(fs.readFileSync(missingPath.outputPath, 'utf8'), 'status')).toBe('failed');
  } finally {
    fs.rmSync(missingPath.tempRoot, { recursive: true, force: true });
  }
});

// flow_id: ci-quality-summary-entrypoint-regression
test('entrypoint fails unresolved and invalid path relationships', () => {
  // Arrange
  const unresolvedInput = {
    jobs: [{
      ...successInput.jobs[0],
      result: '判定不能',
      collection: '取得不可',
      reason: 'unknown',
    }],
  };
  // Act
  const unresolved = runBundled(unresolvedInput);
  const samePath = runBundled(successInput, true, 'same');
  const hardlink = runBundled(successInput, true, 'hardlink');
  try {
    // Assert
    expect(unresolved.result.status).not.toBe(0);
    expect(outputValue(fs.readFileSync(unresolved.outputPath, 'utf8'), 'status')).toBe('unresolved');
    expect(samePath.result.status).not.toBe(0);
    expect(outputValue(fs.readFileSync(samePath.outputPath, 'utf8'), 'status')).toBe('failed');
    expect(hardlink.result.status).not.toBe(0);
    expect(outputValue(fs.readFileSync(hardlink.outputPath, 'utf8'), 'status')).toBe('failed');
  } finally {
    fs.rmSync(unresolved.tempRoot, { recursive: true, force: true });
    fs.rmSync(samePath.tempRoot, { recursive: true, force: true });
    fs.rmSync(hardlink.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-failure-diagnostics.actionable
// flow_id: summary-failure-retention
for (const mode of ['evidence-generation', 'summary-write', 'unknown'] as const) {
  test(`retains source failure when ${mode} fails`, () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-summary-failure-'));
    const evidencePath = path.join(tempRoot, 'evidence.md');
    const summaryPath = path.join(tempRoot, 'summary.md');
    const outputPath = path.join(tempRoot, 'output');
    fs.writeFileSync(outputPath, '');
    if (mode === 'evidence-generation') fs.mkdirSync(evidencePath);
    if (mode === 'summary-write') fs.mkdirSync(summaryPath);
    const mock = path.join(tempRoot, 'failure.mjs');
    fs.writeFileSync(mock, `import fs from 'node:fs';const append=fs.appendFileSync;fs.appendFileSync=(file,...args)=>{if(file===process.env.FAILURE_SUMMARY)throw new Error('private-token-must-not-appear');return append(file,...args);};`);
    try {
      // Act
      const result = spawnSync(process.execPath, [...(mode === 'unknown' ? ['--import', mock] : []), ...bundledEntrypoint], {
        cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: summaryPath, FAILURE_SUMMARY: summaryPath,
          'INPUT_EVIDENCE-PATH': evidencePath, 'INPUT_SUMMARY-PATH': summaryPath,
          'INPUT_SUMMARY-JSON': JSON.stringify({ jobs: [{ unit: 'build', execution: 'build', rawResult: 'failure', applicable: true, evidence: 'original-job-log' }] }),
        },
      });
      // Assert
      expect(result.status).toBe(1);
      const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'))!;
      const evidence = JSON.parse(line.slice('ci-failure-diagnostic:'.length));
      expect(evidence.classification.stage).toBe(mode === 'evidence-generation' ? 'evidence-write' : 'summary-write');
      expect(evidence.context.inputs.sourceOutcome).toBe('failed');
      expect(evidence['execution-state'].write).toBe('write-may-be-partial');
      expect(evidence['evidence-location'].log).toBe('workflow-run-job-step-log');
      expect(evidence['next-check'].stage).toBe(evidence.classification.stage);
      if (mode !== 'evidence-generation') {
        expect(fs.readFileSync(evidencePath, 'utf8')).toContain('job result: failure');
        expect(evidence['evidence-location'].file).toBe('configured-evidence-path');
        expect(evidence['execution-state'].retention).toBe('log-and-file');
      }
      if (mode === 'unknown') {
        expect(evidence.classification).toMatchObject({ reason: 'unknown-failure', cause: 'unknown' });
        expect(evidence['next-check']).toStrictEqual({
          stage: 'summary-write', rule: 'unknown-failure',
          input: evidence.context.inputs, unknownCause: true,
        });
      }
      expect(result.stdout + result.stderr).not.toContain('private-token-must-not-appear');
      expect(fs.readFileSync(outputPath, 'utf8')).not.toContain('success');
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  });
}

});
