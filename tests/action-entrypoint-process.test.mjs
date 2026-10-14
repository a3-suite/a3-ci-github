import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, test, expect } from 'vitest';
import { runActionEntrypoint } from './support/action-entrypoint.ts';

describe('Action test processes', () => {
  describe('runActionEntrypoint', () => {
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: action-entrypoint-process-results
    test('returns both output streams after successful completion', async () => {
      const result = await runActionEntrypoint(['-e', 'process.stdout.write("out");process.stderr.write("err");']);
      expect(result).toMatchObject({ status: 0, signal: null, stdout: 'out', stderr: 'err', error: null });
    });

    // evidence_role: supplemental
    // test_level: integration
    // integration_id: action-entrypoint-process-results
    test('retains a nonzero exit and both output streams', async () => {
      const result = await runActionEntrypoint(['-e', 'process.stdout.write("out");process.stderr.write("err");process.exitCode=7;']);
      expect(result).toMatchObject({ status: 7, signal: null, stdout: 'out', stderr: 'err' });
    });

    // evidence_role: supplemental
    // test_level: integration
    // integration_id: action-entrypoint-process-results
    test('reports signal termination as a failed process', async () => {
      const result = await runActionEntrypoint(['-e', 'process.kill(process.pid,"SIGTERM");']);
      expect(result.status).toBeNull();
      expect(result.signal).toBe('SIGTERM');
      expect(result.error).not.toBeNull();
    });

    // evidence_role: supplemental
    // test_level: integration
    // integration_id: action-entrypoint-process-results
    test('retains launch failure rather than reporting a successful exit', async () => {
      const result = await runActionEntrypoint(['-e', ''], { cwd: path.join(process.cwd(), 'tests/tmp', `missing-process-${randomUUID()}`) });
      expect(result.status).toBeNull();
      expect(result.error.code).toBe('ENOENT');
    });

    // evidence_role: supplemental
    // test_level: integration
    // integration_id: action-entrypoint-process-results
    test('terminates an overdue child before returning its failure', async () => {
      const result = await runActionEntrypoint(['-e', 'setInterval(()=>{},1000);'], { timeout: 300 });
      expect(result.status).toBeNull();
      expect(result.signal).toBe('SIGTERM');
      expect(result.error.killed).toBe(true);
    });

    // evidence_role: supplemental
    // test_level: integration
    // integration_id: action-entrypoint-process-results
    test('bounds captured output and reports the overflow', async () => {
      const result = await runActionEntrypoint(['-e', 'process.stdout.write("x".repeat(8192));setInterval(()=>{},1000);'], { maxBuffer: 1024 });
      expect(result.status).toBeNull();
      expect(result.error.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      expect(result.stdout.length).toBeLessThanOrEqual(1024);
    });
  });
});
