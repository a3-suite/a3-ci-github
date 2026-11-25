import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { buildPlan, runPlan } from '../runtime/repository/check-action-dist.mjs';

describe('bounded distribution builds', () => {
  describe('runPlan and buildPlan', () => {
    // evidence_role: supplemental
    // test_level: unit
    // target_id: runPlan(plan, execute)
    test.each(['action-install', 'action-build'].flatMap(group => [false, true].map(fail => [group, fail])))('bounds active steps and drains before completion (%s, failure=%s)', async (group, fail) => {
      // Arrange
      const calls = [];
      const pending = new Map();
      let active = 0;
      let peak = 0;
      let completed = false;
      const build = (name) => ({ command: 'build', args: [], cwd: `/actions/${name}`, parallelGroup: group });
      const execute = async (command, args, options) => {
        calls.push(command === 'build' ? options.cwd : command);
        if (command !== 'build') return;
        active++;
        peak = Math.max(peak, active);
        try { await new Promise((resolve, reject) => pending.set(options.cwd, { resolve, reject })); }
        finally { active--; }
      };
      // Act
      const result = runPlan([{ command: 'prepare', args: [], cwd: '/' }, build('a'), build('b'), build('c'),
        { command: 'compare', args: [], cwd: '/' }], execute)
        .then(() => { completed = true; }, (error) => { completed = true; return error; });
      await new Promise((resolve) => setImmediate(resolve));
      // Assert
      expect(calls).toEqual(['prepare', '/actions/a', '/actions/b']);
      if (fail) pending.get('/actions/a').reject(Object.assign(new Error('failed'), { status: 7 }));
      else pending.get('/actions/a').resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(calls).toEqual(fail ? ['prepare', '/actions/a', '/actions/b'] : ['prepare', '/actions/a', '/actions/b', '/actions/c']);
      pending.get('/actions/b').resolve();
      if (!fail) pending.get('/actions/c').resolve();
      const outcome = await result;
      expect(active).toBe(0);
      expect(peak).toBe(2);
      if (fail) {
        expect(outcome.details).toMatchObject({ action: 'a', observed: 7 });
        expect(calls).not.toContain('compare');
      } else {
        expect(outcome).toBeUndefined();
        expect(calls.at(-1)).toBe('compare');
      }
    });

    // evidence_role: supplemental
    // test_level: unit
    // target_id: buildPlan(root, actions)
    test('rejects overlapping Action output directories before starting builds', () => {
      // Arrange
      const actions = [
        { name: 'a', path: '/a', distPath: 'dist' },
        { name: 'b', path: '/b', distPath: 'dist/nested' },
      ];
      // Act / Assert
      expect(() => buildPlan('/workspace', actions)).toThrow('action-build-output-overlap');
    });
  });
});
