import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import { resolveConfigSnapshot } from './snapshot.js';

const validatePath = (value: string, error: string): string => {
  if (!value || /[\0\r\n]/.test(value)) throw new Error(error);
  return value;
};

const canonicalPath = (value: string): string => {
  const absolute = path.resolve(value);
  const suffix: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const resolved = fs.realpathSync.native(current);
      return path.join(resolved, ...suffix);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw new Error('config-snapshot-path-invalid');
      const parent = path.dirname(current);
      if (parent === current) throw new Error('config-snapshot-path-invalid');
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
};

export const pathsReferToSameFile = (left: string, right: string): boolean => {
  if (canonicalPath(left) === canonicalPath(right)) return true;
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new Error('config-snapshot-path-invalid');
  }
};

export const run = (): void => {
  try {
    const raw = core.getInput('sources-json', { required: true });
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new Error('config-snapshot-json-invalid'); }
    const snapshotPath = validatePath(core.getInput('snapshot-path', { required: true }), 'config-snapshot-path-invalid');
    const commandOutputPath = process.env.GITHUB_OUTPUT;
    const explicitOutputPath = core.getInput('output-path');
    const outputPath = explicitOutputPath || commandOutputPath;
    for (const candidate of [explicitOutputPath, commandOutputPath]) {
      if (!candidate) continue;
      validatePath(candidate, 'config-snapshot-output-path-invalid');
      if (pathsReferToSameFile(snapshotPath, candidate)) throw new Error('config-snapshot-paths-must-differ');
    }
    const snapshot = resolveConfigSnapshot(input);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
    core.setOutput('status', 'success');
    core.setOutput('snapshot-path', snapshotPath);
    core.setOutput('digest', snapshot.digest);
    if (outputPath) {
      fs.appendFileSync(outputPath, `config_snapshot_path=${snapshotPath}\nconfig_snapshot_digest=${snapshot.digest}\n`, 'utf8');
    }
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
