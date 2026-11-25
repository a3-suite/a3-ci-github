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
  pathMode: 'distinct' | 'same' | 'hardlink' | 'nested' | 'output-directory' = 'distinct',
  envOverrides: Record<string, string | undefined> = {},
  priorSummary?: string,
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
  if (priorSummary !== undefined) fs.writeFileSync(summaryPath, priorSummary, 'utf8');
  if (pathMode === 'hardlink') {
    fs.writeFileSync(summaryPath, '', 'utf8');
    fs.linkSync(summaryPath, evidencePath);
  }
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  delete env['INPUT_SUMMARY-PATH'];
  env.GITHUB_ACTIONS = 'true';
  env.GITHUB_OUTPUT = pathMode === 'output-directory' ? tempRoot : outputPath;
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
  for (const priorSummary of [undefined, '既存のサマリー\r\n\r\n']) {
    const run = runBundled(input, true, 'nested', {}, priorSummary);
    try {
      // Assert
      expect(run.result.status).toBe(0);
      const evidence = fs.readFileSync(run.evidencePath);
      expect(fs.readFileSync(run.summaryPath)).toStrictEqual(Buffer.concat([Buffer.from(priorSummary ?? ''), evidence]));
      expect(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'digest')).toBe(`sha256:${createHash('sha256').update(evidence).digest('hex')}`);
      expect(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'status')).toBe('success');
      expect(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'evidence-path')).toBe(run.evidencePath);
    } finally {
      fs.rmSync(run.tempRoot, { recursive: true, force: true });
    }
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint keeps aggregation and evidence consistent when input conditions combine', () => {
  const cases = [
    { result: 'success', collection: '完了', reason: undefined, status: 'success' },
    { result: 'failed', collection: '完了', reason: 'check failed', status: 'failed' },
    { result: '判定不能', collection: '取得不可', reason: 'check unavailable', status: 'unresolved' },
    { result: 'blocked', collection: '完了', reason: 'check blocked', status: 'blocked' },
    { result: '未実施', collection: '完了', reason: 'check not run', status: 'blocked' },
    { result: 'success', collection: '一部取得', reason: undefined, status: 'unresolved' },
  ];
  const priorSummary = '既存のサマリー\r\n';
  for (const { result, collection, reason, status } of cases) {
    const run = runBundled({ jobs: [
      { unit: 'applicable', execution: 'check', result, collection, reason, evidence: 'applicable.log' },
      { unit: 'explained', execution: 'check', result: 'success', collection: '完了', reason: 'reported context' },
      { unit: 'excluded', execution: 'check', result: '対象外', reason: 'owner policy', collection: '取得不可' },
    ] }, true, 'distinct', runEnv, priorSummary);
    try {
      const evidence = fs.readFileSync(run.evidencePath);
      const outputs = fs.readFileSync(run.outputPath, 'utf8');
      expect(run.result.status, status).toBe(status === 'success' ? 0 : 1);
      expect(outputValue(outputs, 'status')).toBe(status);
      expect(outputValue(outputs, 'evidence-path')).toBe(run.evidencePath);
      expect(outputValue(outputs, 'digest')).toBe(`sha256:${createHash('sha256').update(evidence).digest('hex')}`);
      expect(fs.readFileSync(run.summaryPath)).toStrictEqual(Buffer.concat([Buffer.from(priorSummary), evidence]));
      const markdown = evidence.toString('utf8');
      expect(markdown).toContain('| `applicable` |');
      for (const unit of ['explained', 'excluded']) {
        expect(markdown).toContain(`- 対象: \`${unit}\`\n- 証跡: \`${runUrl}\``);
      }
      if (status !== 'success') {
        expect(markdown).toContain('- 対象: `applicable`\n- 証跡: `applicable.log`');
        expect(run.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"summary-result"/m);
      } else {
        expect(markdown).not.toContain('- 対象: `applicable`');
      }
    } finally {
      fs.rmSync(run.tempRoot, { recursive: true, force: true });
    }
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint diagnoses failure to write Action outputs', () => {
  const run = runBundled(successInput, true, 'output-directory');
  try {
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"output-write"/m);
    expect(fs.existsSync(run.evidencePath)).toBe(true);
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint uses the workflow run URL for rows without evidence', () => {
  const run = runBundled({
    jobs: [{ unit: 'build', execution: 'build', rawResult: 'failure', applicable: true }],
    tests: [
      { unit: 'contract', execution: 'node', result: 'failed', collection: '完了', reason: 'assertion failed' },
      { unit: 'explicit', execution: 'node', result: 'failed', evidence: 'explicit.log', collection: '完了', reason: 'assertion failed' },
      { unit: 'successful', execution: 'node', result: 'success', collection: '完了' },
      { unit: 'excluded', execution: 'node', result: '対象外', collection: '取得不可', reason: 'owner policy' },
    ],
  }, true, 'distinct', runEnv);
  try {
    const evidence = fs.readFileSync(run.evidencePath, 'utf8');
    const outputs = fs.readFileSync(run.outputPath, 'utf8');
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"summary-result"/m);
    expect(outputValue(outputs, 'status')).toBe('failed');
    expect(outputValue(outputs, 'evidence-path')).toBe(run.evidencePath);
    expect(outputValue(outputs, 'digest')).toBe(`sha256:${createHash('sha256').update(fs.readFileSync(run.evidencePath)).digest('hex')}`);
    expect(evidence).toContain('| `successful` |');
    expect(evidence).not.toContain('- 対象: `successful`');
    expect([...evidence.matchAll(/^- 対象: `([^`]+)`\n- 証跡: `([^`]+)`$/gm)].map(([, unit, reference]) => [unit, reference])).toStrictEqual([
      ['build', runUrl],
      ['contract', runUrl],
      ['explicit', 'explicit.log'],
      ['excluded', runUrl],
    ]);
    expect(evidence).toBe(fs.readFileSync(run.summaryPath, 'utf8'));
    const line = run.result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'))!;
    expect(JSON.parse(line.slice('ci-failure-diagnostic:'.length)).context.inputs.jobs).toEqual([{ unit: 'build', rawResult: 'failure', evidence: runUrl }]);
    const supplied = runBundled({ jobs: [
      { unit: 'build', execution: 'build', rawResult: 'failure', applicable: true, evidence: 'build.log' },
      { unit: 'successful', execution: 'test', rawResult: 'success', applicable: true, evidence: 'test.log' },
    ] }, true, 'distinct', runEnv);
    try {
      const details = fs.readFileSync(supplied.evidencePath, 'utf8');
      expect(details).toContain('- 対象: `build`\n- 証跡: `build.log`');
      expect(details).toContain('| `successful` |');
      expect(details).not.toContain('- 対象: `successful`');
    } finally {
      fs.rmSync(supplied.tempRoot, { recursive: true, force: true });
    }
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
    } finally {
      fs.rmSync(run.tempRoot, { recursive: true, force: true });
    }
  }
});

// evidence_role: supplemental
// The absence of an evidence file after a rejected run context is a side effect that no contract guarantee covers.
test('entrypoint writes no evidence file when the run context is missing or invalid', () => {
  // Arrange
  const row = { unit: 'build', execution: 'build', rawResult: 'success', applicable: true };
  for (const overrides of [{ GITHUB_RUN_ID: undefined }, { GITHUB_RUN_ID: '42\nINJECTED' }, { GITHUB_SERVER_URL: 'http://github.com' }, { GITHUB_SERVER_URL: 'https://github.com:99999' }, { GITHUB_SERVER_URL: 'https://github.com/path' }, { GITHUB_REPOSITORY: 'owner' }]) {
    // Act
    const run = runBundled({ jobs: [row] }, true, 'distinct', { ...runEnv, ...overrides });
    try {
      // Assert
      expect(run.result.status, JSON.stringify(overrides)).not.toBe(0);
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
    const outputs = fs.readFileSync(run.outputPath, 'utf8');
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"summary-result"/m);
    expect(outputValue(outputs, 'status')).toBe('failed');
    expect(outputValue(outputs, 'evidence-path')).toBe(run.evidencePath);
    expect(outputValue(outputs, 'digest')).toBe(`sha256:${createHash('sha256').update(fs.readFileSync(run.evidencePath)).digest('hex')}`);
    expect(fs.readFileSync(run.evidencePath, 'utf8')).toMatch(/job result: failure/);
    expect(fs.readFileSync(run.evidencePath, 'utf8')).toBe(fs.readFileSync(run.summaryPath, 'utf8'));
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint ignores intentionally excluded test rows in the aggregate status', () => {
  // Arrange
  const input = { tests: [
    { unit: 'considered', execution: 'node', result: 'success', evidence: 'tests', collection: '完了' },
    { unit: 'intentionally-excluded', execution: 'node', result: '対象外', evidence: 'owner-policy', collection: '完了', reason: 'excluded by owner policy' },
  ] };
  // Act
  const run = runBundled(input);
  try {
    // Assert
    expect(run.result.status, run.result.stderr).toBe(0);
    const outputs = fs.readFileSync(run.outputPath, 'utf8');
    expect(outputValue(outputs, 'status')).toBe('success');
    expect(outputValue(outputs, 'evidence-path')).toBe(run.evidencePath);
    expect(outputValue(outputs, 'digest')).toBe(`sha256:${createHash('sha256').update(fs.readFileSync(run.evidencePath)).digest('hex')}`);
    expect(fs.readFileSync(run.evidencePath, 'utf8')).toMatch(/⏭ 対象外/);
    expect(fs.readFileSync(run.evidencePath, 'utf8')).toBe(fs.readFileSync(run.summaryPath, 'utf8'));
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint keeps the applicable job status when an uncollected job row is excluded', () => {
  // Arrange
  const input = { jobs: [
    { unit: 'unit', execution: 'test command', result: 'success', evidence: 'evidence.log', collection: '完了' },
    { unit: 'unit', execution: 'test command', result: '対象外', evidence: 'evidence.log', collection: '取得不可', reason: 'disabled by owner contract' },
  ] };
  // Act
  const run = runBundled(input);
  try {
    // Assert
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'status')).toBe('success');
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint fails an input where every row is excluded', () => {
  // Arrange
  const input = { tests: [
    { unit: 'intentionally-excluded', execution: 'node', result: '対象外', evidence: 'owner-policy', collection: '完了', reason: 'excluded by owner policy' },
  ] };
  // Act
  const run = runBundled(input);
  try {
    // Assert
    expect(run.result.status, run.result.stderr).toBe(1);
    expect(run.result.stderr).toMatch(/ci-summary-all-excluded/);
    expect(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'status')).toBe('failed');
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
test('entrypoint diagnoses missing and malformed summary JSON', () => {
  for (const input of [undefined, '{']) {
    const run = runBundled(successInput, true, 'distinct', { 'INPUT_SUMMARY-JSON': input });
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"summary-input"/m);
    } finally {
      fs.rmSync(run.tempRoot, { recursive: true, force: true });
    }
  }
  // Parsable JSON whose rows cannot be classified.
  const [job] = successInput.jobs;
  for (const input of [
    { jobs: [] },
    { jobs: [{ ...job, unit: undefined }] },
    { jobs: [{ ...job, result: 'failed', reason: undefined }] },
    { jobs: [{ ...job, result: 'passed' }] },
    { jobs: [{ ...job, rawResult: 'success', applicable: true }] },
  ]) {
    const run = runBundled(input, true, 'distinct', runEnv);
    try {
      expect(run.result.status, JSON.stringify(input)).toBe(1);
      expect(run.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"summary-classification"/m);
    } finally {
      fs.rmSync(run.tempRoot, { recursive: true, force: true });
    }
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
    expect(missingPath.result.status, missingPath.result.stderr).toBe(1);
    expect(outputValue(fs.readFileSync(missingPath.outputPath, 'utf8'), 'status')).toBe('failed');
  } finally {
    fs.rmSync(missingPath.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// flow_id: ci-quality-summary-contract-entrypoint
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
    expect(unresolved.result.status, unresolved.result.stderr).toBe(1);
    expect(outputValue(fs.readFileSync(unresolved.outputPath, 'utf8'), 'status')).toBe('unresolved');
    expect(samePath.result.status, samePath.result.stderr).toBe(1);
    expect(outputValue(fs.readFileSync(samePath.outputPath, 'utf8'), 'status')).toBe('failed');
    expect(hardlink.result.status, hardlink.result.stderr).toBe(1);
    expect(outputValue(fs.readFileSync(hardlink.outputPath, 'utf8'), 'status')).toBe('failed');
  } finally {
    fs.rmSync(unresolved.tempRoot, { recursive: true, force: true });
    fs.rmSync(samePath.tempRoot, { recursive: true, force: true });
    fs.rmSync(hardlink.tempRoot, { recursive: true, force: true });
  }
});

const retainsSourceFailure = (mode: 'evidence-generation' | 'summary-write' | 'unknown') => {
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
    if (mode === 'evidence-generation') {
      expect(evidence['evidence-location'].file).toBe('not-generated');
      expect(evidence['execution-state'].retention).toBe('log-only');
    } else {
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
    expect(outputValue(fs.readFileSync(outputPath, 'utf8'), 'status')).toBe('failed');
  } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
};

// contract_id: contract.ci-failure-diagnostics.actionable
// flow_id: summary-failure-retention
for (const mode of ['evidence-generation', 'summary-write'] as const) {
  test(`retains source failure when ${mode} fails`, () => retainsSourceFailure(mode));
}

// evidence_role: supplemental
// The diagnostic of a failure whose cause is unknown is not observed by a verification case of contract.ci-failure-diagnostics.actionable.
// flow_id: summary-failure-retention
test('retains source failure when unknown fails', () => retainsSourceFailure('unknown'));

});
