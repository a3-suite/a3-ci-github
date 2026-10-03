import * as core from '@actions/core';
import fs from 'node:fs';
import path from 'node:path';
import { executeAdapter, loadAdapterBundle, parseAdapterBundle } from './adapter.js';
import { standardQualityBundle } from '../../../runtime/adapter/standard-quality-bundles.js';

export const run = (): void => {
  try {
    const bundlePath = core.getInput('bundle-path');
    const standardId = core.getInput('standard-bundle-id');
    if (Boolean(bundlePath) === Boolean(standardId)) throw new Error('quality-adapter-bundle-selection-invalid');
    const standard = standardId ? standardQualityBundle(standardId) : undefined;
    const bundle = standard ? parseAdapterBundle(standard.descriptor) : loadAdapterBundle(path.resolve(bundlePath));
    if (standard && (bundle.id !== standard.id || bundle.owner !== standard.owner || bundle.assets.length !== 0)) {
      throw new Error('quality-adapter-standard-bundle-metadata-invalid');
    }
    const resultPath = path.resolve(core.getInput('result-path', { required: true }));
    const payload = executeAdapter(bundle, {
      sourceRoot: path.resolve(core.getInput('source-root', { required: true })),
      languageProfile: core.getInput('language-profile') || undefined,
      toolchainVersion: core.getInput('toolchain-version', { required: true }),
      requireTrustedProjectScripts: core.getBooleanInput('require-trusted-project-scripts'),
      trustedProjectRoot: core.getInput('trusted-project-root') || undefined,
    });
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    const resultJson = `${JSON.stringify(payload, null, 2)}\n`;
    fs.writeFileSync(resultPath, resultJson, 'utf8');
    core.setOutput('status', payload.status);
    core.setOutput('result-path', resultPath);
    process.stdout.write(resultJson);
    if (payload.status !== 'success') core.setFailed(`quality-adapter-${payload.status}`);
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
