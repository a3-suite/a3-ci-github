import { test, describe, expect, onTestFinished } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
describe('release token capability probe', () => {
  describe('isolated ownership and draft visibility', () => {
    // evidence_role: supplemental
    // integration_id: release-token-capability-probe
    test.each([{ visible: true, changed: false, transport: false }, { visible: false, changed: false, transport: false }, { visible: true, changed: true, transport: false }, { visible: true, changed: false, transport: true }, { visible: true, changed: false, transport: false, listTransport: true }])('detects draft visibility or fails closed without leaking the token: %s', ({ visible, changed, transport, listTransport = false }) => {
      // Arrange
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const directory = fs.mkdtempSync(path.join(root, 'tmp/token-probe-test-'));
      onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
      const entry = new URL('./support/release-token-capability-probe.mjs', import.meta.url).href;
      const code = `let created = false; let directReads = 0;
        globalThis.fetch = async (url, options) => {
          const endpoint = new URL(url).pathname;
          if (options.headers.authorization !== 'Bearer synthetic-private-token') throw new Error('test-credential-mismatch');
          if (endpoint.endsWith('/a3-ci-github')) return Response.json({ default_branch: 'main', permissions: { push: false } });
          if (endpoint.includes('/commits/')) return Response.json({ sha: 'a'.repeat(40) });
          const draft = { id: 42, tag_name: 'ci-capability-probe-123-1', draft: true };
          if (options.method === 'POST') { created = true; return Response.json(draft, { status: 201 }); }
          if (options.method === 'DELETE') { created = false; return new Response(null, { status: 204 }); }
          if (endpoint.endsWith('/42')) { directReads++; if (${transport} && directReads === 1) throw new Error('synthetic-private-token response fragment'); return Response.json({ ...draft, draft: !(${changed} && directReads > 1) }); }
          if (created && ${listTransport}) throw new Error('synthetic-private-token list fragment');
          return Response.json(created && ${visible} ? (new URL(url).searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, index) => ({ id: index + 101 })) : [draft]) : []);
        };
        await import(${JSON.stringify(entry)});`;
      // Act
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: directory, encoding: 'utf8', env: {
        ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'a3-suite/a3-ci-github', GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_TOKEN: 'synthetic-private-token', CI_RELEASE_CONTENTS_PERMISSION: 'write', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
      } });
      const report = fs.readFileSync(path.join(directory, 'logs/release-token-capability.json'), 'utf8');
      // Assert
      expect(result.status).toBe(visible && !changed && !transport && !listTransport ? 0 : 1);
      expect(report).not.toContain('synthetic-private-token');
      expect(JSON.parse(report).cleanup).toEqual({ release_id: 42, deleted: !changed });
      expect(JSON.parse(report).status).toBe(visible && !changed && !transport && !listTransport ? 'success' : 'failure');
      expect(JSON.parse(report).api_permissions_push).toBe(false);
      if (changed) expect(JSON.parse(report).calls.some(call => call.method === 'DELETE')).toBe(false);
      if (transport || listTransport) expect(JSON.parse(report).reason).toBe('probe-transport-or-response-invalid');
      if (listTransport) expect(JSON.parse(report).draft).toMatchObject({ get_by_id: true, full_list: false, pages: null, observations: 0 });
      if (!visible) {
        expect(JSON.parse(report).reason).toBe('probe-draft-not-listed');
        expect(JSON.parse(report).draft).toMatchObject({ get_by_id: true, full_list: false, matched_ids: 0, observations: 3 });
      }
      if (visible && !transport && !listTransport) expect(JSON.parse(report).draft).toMatchObject({ get_by_id: true, full_list: true, pages: 2 });
    });
  });
});
