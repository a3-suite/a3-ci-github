import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { qualityAdapterDescriptor, publicationRequestInputs } from './action-reference-fixtures.mjs';

export function verifyActionReferenceContracts(root, references, snapshot) {
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const directory = mkdtempSync(path.join(root, 'tmp/action-reference-contracts-'));
  const observations = [];
  const selected = [...new Set(references.map(({ uses }) => uses))].filter((uses) => /\/actions\/ci-(quality-adapter|release-publication-control)@/.test(uses));
  try {
    for (const action of ['ci-quality-adapter', 'ci-release-publication-control']) if (!selected.some((uses) => uses.includes(`/actions/${action}@`))) throw new Error(`Required Action contract reference is missing: ${action}`);
    for (const uses of selected) {
      const [, actionPath, sha] = /^a3-suite\/a3-ci-github\/(actions\/[a-z0-9-]+)@([0-9a-f]{40})$/.exec(uses) ?? [];
      if (!actionPath) throw new Error(`Invalid Action reference: ${uses}`);
      const entrypoint = path.join(directory, `${path.basename(actionPath)}-${sha}.cjs`);
      writeFileSync(entrypoint, execFileSync('git', ['show', `${sha}:${actionPath}/dist/index.js`], { cwd: root, stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 }));
      const run = (name, inputs) => {
        const working = path.join(directory, `${path.basename(actionPath)}-${name}`);
        mkdirSync(working);
        const output = path.join(working, 'output');
        writeFileSync(output, '');
        const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
        const result = spawnSync(process.execPath, [entrypoint], { cwd: working, encoding: 'utf8', timeout: 30_000,
          env: { ...environment, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, ...inputs(working) } });
        if (result.error || result.signal || result.status === null || ['custom', 'valid'].includes(name) && result.status !== 0) throw new Error(`Action contract execution unavailable: ${uses}:${name}`);
        return { result, working, output: readFileSync(output, 'utf8'), log: `${result.stdout}${result.stderr}` };
      };
      if (actionPath === 'actions/ci-quality-adapter') {
        for (const [name, id] of [['custom', 'node-quality'], ['reserved', 'typescript-npm-quality']]) {
          const runResult = run(name, (working) => {
            const descriptor = path.join(working, 'adapter.yml');
            writeFileSync(descriptor, qualityAdapterDescriptor().replace('id: node-quality', `id: ${id}`));
            return { 'INPUT_BUNDLE-PATH': descriptor, 'INPUT_SOURCE-ROOT': working,
              'INPUT_RESULT-PATH': path.join(working, 'result.json'), 'INPUT_TOOLCHAIN-VERSION': process.version.slice(1),
              'INPUT_REQUIRE-TRUSTED-PROJECT-SCRIPTS': 'false' };
          });
          const passed = name === 'custom'
            ? runResult.result.status === 0 && JSON.parse(readFileSync(path.join(runResult.working, 'result.json'), 'utf8')).status === 'success'
            : runResult.result.status === 1 && runResult.log.includes('quality-adapter-standard-id-requires-action-bundle') && !existsSync(path.join(runResult.working, 'result.json'));
          observations.push({ uses, case: `quality-${name}`, passed });
        }
      } else {
        for (const missing of [null, 'INPUT_RELEASE-VERSION', 'INPUT_TARGET-IDENTITY', 'owner-decision']) {
          const name = missing ?? 'valid';
          const runResult = run(name, (working) => ({ ...publicationRequestInputs(working), ...(missing === 'owner-decision'
            ? { 'INPUT_RELEASE-VERSION': '', 'INPUT_TARGET-IDENTITY': '' } : missing ? { [missing]: '' } : {}) }));
          const request = path.join(runResult.working, 'release-publication-request/request.json');
          const error = missing === 'INPUT_RELEASE-VERSION' || missing === 'owner-decision' ? 'release-publication-releaseVersion-invalid' : 'release-publication-targetIdentity-invalid';
          const passed = missing
            ? runResult.result.status === 1 && runResult.log.includes(error) && !existsSync(path.dirname(request)) && !existsSync(path.join(runResult.working, 'release-notes-handoff'))
            : runResult.result.status === 0 && JSON.parse(readFileSync(request, 'utf8')).schema === 'ci.release-publication-request.v2';
          observations.push({ uses, case: `publication-${name}`, passed });
        }
      }
    }
    snapshot?.assertUnchanged();
    return { observations, diagnostics: observations.filter(({ passed }) => !passed).map(({ uses, case: name }) => `${uses}: referenced Action contract failed: ${name}`) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
