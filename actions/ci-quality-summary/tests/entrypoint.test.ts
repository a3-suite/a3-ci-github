import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';


const root = path.resolve(__dirname, '..');
const bundledEntrypoint = path.join(root, 'dist/index.js');

const runBundled = (
  input: unknown,
  includeSummaryPath = true,
  pathMode: 'distinct' | 'same' | 'hardlink' | 'nested' = 'distinct',
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
  const result = spawnSync(process.execPath, [bundledEntrypoint], {
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
  assert.ok(match, `missing output: ${name}`);
  return match[1];
};

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
// integration_id: ci-quality-summary-contract-entrypoint
test('bundled entrypoint writes matching evidence and outputs', () => {
  // Arrange
  const input = successInput;
  // Act
  const run = runBundled(input, true, 'nested');
  try {
    // Assert
    assert.equal(run.result.status, 0);
    const evidence = fs.readFileSync(run.evidencePath, 'utf8');
    assert.equal(evidence, fs.readFileSync(run.summaryPath, 'utf8'));
    assert.equal(
      outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'digest'),
      `sha256:${createHash('sha256').update(evidence, 'utf8').digest('hex')}`,
    );
    assert.equal(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'status'), 'success');
    assert.equal(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'evidence-path'), run.evidencePath);
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// integration_id: ci-quality-summary-contract-entrypoint
test('bundled entrypoint normalizes a raw GitHub job result', () => {
  const run = runBundled({ jobs: [{
    unit: 'build', execution: 'build', rawResult: 'failure', applicable: true, evidence: 'run',
  }] });
  try {
    assert.notEqual(run.result.status, 0);
    assert.equal(outputValue(fs.readFileSync(run.outputPath, 'utf8'), 'status'), 'failed');
    assert.match(fs.readFileSync(run.evidencePath, 'utf8'), /job result: failure/);
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// contract_id: contract.ci-quality-summary.outputs
// integration_id: ci-quality-summary-contract-entrypoint
test('bundled entrypoint rejects a missing summary path', () => {
  // Arrange
  // Act
  const missingPath = runBundled(successInput, false);
  try {
    // Assert
    assert.notEqual(missingPath.result.status, 0);
    assert.equal(outputValue(fs.readFileSync(missingPath.outputPath, 'utf8'), 'status'), 'failed');
  } finally {
    fs.rmSync(missingPath.tempRoot, { recursive: true, force: true });
  }
});

// integration_id: ci-quality-summary-entrypoint-regression
test('bundled entrypoint fails unresolved and invalid path relationships', () => {
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
    assert.notEqual(unresolved.result.status, 0);
    assert.equal(outputValue(fs.readFileSync(unresolved.outputPath, 'utf8'), 'status'), 'unresolved');
    assert.notEqual(samePath.result.status, 0);
    assert.equal(outputValue(fs.readFileSync(samePath.outputPath, 'utf8'), 'status'), 'failed');
    assert.notEqual(hardlink.result.status, 0);
    assert.equal(outputValue(fs.readFileSync(hardlink.outputPath, 'utf8'), 'status'), 'failed');
  } finally {
    fs.rmSync(unresolved.tempRoot, { recursive: true, force: true });
    fs.rmSync(samePath.tempRoot, { recursive: true, force: true });
    fs.rmSync(hardlink.tempRoot, { recursive: true, force: true });
  }
});
