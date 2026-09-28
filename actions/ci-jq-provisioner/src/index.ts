import { provisionJqOnPath } from './provision.js';

async function main(): Promise<void> {
  const version = process.env['INPUT_JQ-VERSION'] ?? '';
  const runnerOs = process.env.RUNNER_OS ?? '';
  const runnerArch = process.env.RUNNER_ARCH ?? '';
  const tempRoot = process.env.RUNNER_TEMP ?? '';
  const githubPath = process.env.GITHUB_PATH ?? '';
  if (!tempRoot || !githubPath) throw new Error('jq-provision-failed: runner paths unavailable');

  await provisionJqOnPath({
    version, runnerOs, runnerArch, tempRoot,
    fetchAsset: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    },
  }, githubPath);
}

if (process.env.GITHUB_ACTIONS === 'true') {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
