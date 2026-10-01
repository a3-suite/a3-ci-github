import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fixture, source, repository } from './fixture';

// integration_id: ci-release-authority-bundle
// contract_id: contract.ci-release-authority.outputs
test('authority bundle emits verified outputs and suppresses outputs on rejection', () => {
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
      const result = spawnSync(process.execPath, ['--import', preload, path.resolve(__dirname, '../dist/index.js')], { env, encoding: 'utf8' });
      assert.equal(result.status, invalid ? 1 : 0, result.stderr);
      assert.equal(result.stderr.includes('synthetic-secret'), false);
      const bytes = fs.readFileSync(output, 'utf8');
      if (invalid) { assert.equal(bytes, ''); assert.equal(fs.existsSync(f.options.outputDirectory), false); }
      else { assert.ok(bytes.includes(`source_sha=${source}\n`)); assert.ok(bytes.includes('version=1.2.3\n')); }
    } finally { fs.rmSync(f.root, { recursive: true }); }
  }
});
