import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, test, onTestFinished } from 'vitest';

const workflows = [
  ['quality', '.github/workflows/ci-quality.yml'],
  ['release-publication', '.github/workflows/ci-release-publication.yml'],
  ['package-publication', '.github/workflows/ci-package-publication.yml'],
];

describe('workflow failure diagnostics', () => {
  // contract_id: contract.ci-failure-diagnostics.actionable
  // integration_id: workflow-summary-failure-retention
  test.each(['workflows/release/release-publication-request.yml', 'workflows/release/release-request-tag.yml', 'workflows/package/package-publication-request.yml'].flatMap(file => ['success', 'failure', 'cancelled'].map(status => [file, status])))('%s summary preserves the current job %s result', (file, status) => {
    // Arrange
    const workflow = parse(fs.readFileSync(file, 'utf8'));
    const separate = file === 'workflows/release/release-request-tag.yml';
    const summary = separate ? workflow.jobs.summary : workflow.jobs.request;
    const step = summary.steps.at(-1);
    expect(Object.keys(workflow.jobs)).toStrictEqual(separate ? ['request', 'summary'] : ['request']);
    expect(separate ? summary.if : step.if).toBe('always()');
    if (separate) {
      expect(summary.needs).toBe('request');
      expect(summary.permissions).toEqual({ contents: 'read' });
    }
    const runUrl = 'https://github.com/owner/product/actions/runs/123';
    const input = step.with['summary-json'].replaceAll('${{ job.status }}', status)
      .replaceAll('${{ needs.request.result }}', status)
      .replaceAll('${{ env.WORKFLOW_RUN_URL }}', runUrl);
    fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('tests/tmp/publication-request-summary-'));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, 'output');
    const evidencePath = path.join(directory, 'evidence.md');
    fs.writeFileSync(output, '');
    // Act
    const result = spawnSync(process.execPath, ['actions/ci-quality-summary/dist/index.js'], { encoding: 'utf8', env: {
      ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, GITHUB_RUN_ID: '123', GITHUB_JOB: 'request',
      'INPUT_SUMMARY-JSON': input, 'INPUT_SUMMARY-PATH': path.join(directory, 'summary.md'), 'INPUT_EVIDENCE-PATH': evidencePath,
    } });
    // Assert
    expect(result.status).toBe(status === 'success' ? 0 : 1);
    const markdown = fs.readFileSync(evidencePath, 'utf8');
    expect(markdown).toContain(`request job result: ${status}`);
    expect(markdown).toContain(runUrl);
    if (status !== 'success') {
      const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
      const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
      expect(evidence.context.inputs.jobs[0]).toEqual({ unit: 'request', rawResult: status, evidence: runUrl });
    }
  });

  // contract_id: contract.ci-failure-diagnostics.actionable
  // integration_id: workflow-summary-failure-retention
  test.each(workflows)('%s aggregate retains failed job identity and run evidence', (_name, file) => {
    // Local component wiring; GitHub scheduling and expressions need Hosted evidence.
    const workflow = parse(fs.readFileSync(file, 'utf8'));
    const summary = Object.values(workflow.jobs).find(job => job.steps?.some(step => step.with?.['summary-json']));
    const step = summary.steps.find(step => step.with?.['summary-json']);
    expect(summary.if).toContain('always()');
    const ids = [...step.with['summary-json'].matchAll(/"rawResult":"\$\{\{ needs\.([a-z-]+)\.result \}\}"/g)].map(match => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    const needs = Array.isArray(summary.needs) ? summary.needs : [summary.needs];
    for (const id of ids) expect(needs).toContain(id);
    fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('tests/tmp/workflow-diagnostic-'));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, 'output');
    const evidencePath = path.join(directory, 'evidence.md');
    fs.writeFileSync(output, '');
    const runUrl = 'https://github.com/owner/product/actions/runs/123';
    const input = { jobs: ids.map((unit, index) => ({ unit, execution: 'workflow job', rawResult: index === 0 ? 'failure' : 'skipped', applicable: index === 0, evidence: runUrl, reason: index === 0 ? 'job result: failure' : 'branch intentionally excluded' })) };
    const result = spawnSync(process.execPath, ['actions/ci-quality-summary/dist/index.js'], { encoding: 'utf8', env: {
      ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, GITHUB_RUN_ID: '123', GITHUB_JOB: 'summary',
      'INPUT_SUMMARY-JSON': JSON.stringify(input), 'INPUT_SUMMARY-PATH': path.join(directory, 'summary.md'), 'INPUT_EVIDENCE-PATH': evidencePath,
    } });
    const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
    const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
    expect(result.status).toBe(1);
    expect(evidence.context).toMatchObject({ run: '123', job: 'summary' });
    expect(evidence.context.inputs.jobs[0]).toEqual({ unit: ids[0], rawResult: 'failure', evidence: runUrl });
    expect(evidence.context.inputs.sourceOutcome).toBe('failed');
    expect(evidence['execution-state'].retention).toBe('log-and-file');
    const markdown = fs.readFileSync(evidencePath, 'utf8');
    expect(markdown).toContain('job result: failure');
    expect(markdown).toContain(runUrl);
    expect(markdown).toContain(ids[0]);
  });
});
