import * as core from '@actions/core';
import fs from 'node:fs';
import path from 'node:path';
import { executeAdapter, loadAdapterBundle } from './adapter.js';

export const run = (): void => {
  try {
    const bundle = loadAdapterBundle(path.resolve(core.getInput('bundle-path', { required: true })));
    const resultPath = path.resolve(core.getInput('result-path', { required: true }));
    const payload = executeAdapter(bundle, {
      sourceRoot: path.resolve(core.getInput('source-root', { required: true })),
      languageProfile: core.getInput('language-profile') || undefined,
      toolchainVersion: core.getInput('toolchain-version', { required: true }),
      requireTrustedProjectScripts: core.getBooleanInput('require-trusted-project-scripts'),
      trustedProjectRoot: core.getInput('trusted-project-root') || undefined,
    });
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    core.setOutput('status', payload.status);
    core.setOutput('result-path', resultPath);
    if (payload.status !== 'success') core.setFailed(`quality-adapter-${payload.status}`);
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
