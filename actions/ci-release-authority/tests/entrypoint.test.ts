import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';
import { fixture, source, repository } from './fixture';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
// integration_id: ci-release-authority-bundle
// contract_id: contract.ci-release-authority.outputs
test('authority entrypoint emits verified outputs and suppresses outputs on rejection', () => {
  for (const invalid of [false, true]) {
    const f = fixture();
    try {
      const responses = path.join(f.root, 'responses.json');
      fs.writeFileSync(responses, JSON.stringify(f.responses));
      const preload = path.join(f.root, 'mock-fetch.mjs');
      fs.writeFileSync(preload, `import fs from 'node:fs';\nconst responses = JSON.parse(fs.readFileSync(process.env.TEST_RESPONSES));\nglobalThis.fetch = async (url, init) => { if (init.method !== 'GET') throw new Error('write-forbidden'); return new Response(JSON.stringify(responses[String(url).replace('https://api.github.com', '')] ?? {}), {status:200}); };\n`);
      const output = path.join(f.root, 'output');
      fs.writeFileSync(output, '');
      const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: output,
        TEST_RESPONSES: responses, 'INPUT_ROOT-DIRECTORY': f.root, 'INPUT_SNAPSHOT-PATH': 'snapshot.json', 'INPUT_OUTPUT-DIRECTORY': f.options.outputDirectory,
        'INPUT_RELEASE-REQUEST-RUN-ID': '11', 'INPUT_PUBLICATION-REQUEST-RUN-ID': '22', 'INPUT_GITHUB-TOKEN': invalid ? '' : 'synthetic-secret' };
      const result = spawnSync(process.execPath, ['--import', preload, ...entrypointArgs], { env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(invalid ? 1 : 0);
      expect(result.stderr.includes('synthetic-secret')).toBe(false);
      const bytes = fs.readFileSync(output, 'utf8');
      if (invalid) { expect(bytes).toBe(''); expect(fs.existsSync(f.options.outputDirectory)).toBe(false); }
      else { expect(bytes.includes(`source_sha=${source}\n`)).toBeTruthy(); expect(bytes.includes('version=1.2.3\n')).toBeTruthy(); }
    } finally { fs.rmSync(f.root, { recursive: true }); }
  }
});

});
