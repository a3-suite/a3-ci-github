import { completeFailure, FailureContext, safeErrorReason, DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import { provisionJqOnPath } from './provision.js';
import { provisionWriteState } from '../../../runtime/provisioner/provision-core.js';

const diagnostic = new FailureContext('ci-jq-provisioner', 'provision');
async function main(): Promise<void> {
  const version = process.env['INPUT_JQ-VERSION'] ?? '';
  const runnerOs = process.env.RUNNER_OS ?? '';
  const runnerArch = process.env.RUNNER_ARCH ?? '';
  const tempRoot = process.env.RUNNER_TEMP ?? '';
  const githubPath = process.env.GITHUB_PATH ?? '';
  if (!tempRoot || !githubPath) throw new DiagnosticError('jq-provision-failed: runner paths unavailable', { diagnosticCode: 'jq-provision-failed-runner-paths-unavailable' });

  diagnostic.confirmed();
  diagnostic.at('download-verify-install', { input: 'exact-version', tool: 'jq' });
  await provisionJqOnPath({
    version, runnerOs, runnerArch, tempRoot,
    fetchAsset: async (url) => {
      diagnostic.at('asset-download', { input: 'provider-release-asset' });
      const response = await fetch(url);
      if (!response.ok) throw new DiagnosticError('provider-download-failed', { diagnostics: { 'http-status': response.status, method: 'GET', 'request-id': /^[A-Za-z0-9:-]{1,100}$/.test(response.headers.get('x-github-request-id') ?? '') ? response.headers.get('x-github-request-id') : 'unavailable' } });
      return Buffer.from(await response.arrayBuffer());
    },
  }, githubPath);
}

if (process.env.GITHUB_ACTIONS === 'true') {
  main().catch((error: unknown) => {
    diagnostic.writeState = provisionWriteState(error);
    diagnostic.report(error);
    completeFailure(safeErrorReason(error), 1);
  });
}
