import * as core from '@actions/core';
import { createRequest, verifyRequest, type RequestFields } from './request.js';

export const run = (): void => {
  try {
    const operation = core.getInput('operation', { required: true });
    const requestPath = core.getInput('request-path', { required: true });
    let result: RequestFields;
    if (operation === 'create') {
      result = createRequest(requestPath, {
        sourceSha: core.getInput('source-sha', { required: true }),
        version: core.getInput('version', { required: true }),
        targetIdentity: core.getInput('target-identity', { required: true }),
        languageProfile: core.getInput('language-profile', { required: true }),
        toolchain: core.getInput('toolchain', { required: true }),
      });
    } else if (operation === 'verify') {
      result = verifyRequest(requestPath, core.getInput('expected-source-sha', { required: true }));
    } else {
      throw new Error('package-publication-operation-invalid');
    }
    core.setOutput('status', 'success');
    core.setOutput('request-path', requestPath);
    core.setOutput('source-sha', result.sourceSha);
    core.setOutput('version', result.version);
    core.setOutput('target-identity', result.targetIdentity);
    core.setOutput('language-profile', result.languageProfile);
    core.setOutput('toolchain', result.toolchain);
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
