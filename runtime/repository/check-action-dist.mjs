import { completeFailure, DiagnosticError, FailureContext, safeErrorReason } from '../diagnostics/failure.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, '../..');
const bundledFiles = ['package.json', 'src/index.ts', 'dist/index.js'];

const runtimeFor = (actionPath) => {
  const content = readFileSync(path.join(actionPath, 'action.yml'), 'utf8');
  const match = content.match(/^\s{2}using:\s*['"]?([^'"\s]+)['"]?\s*$/m);
  if (!match) throw new DiagnosticError(`action-runtime-missing: Action ${path.basename(actionPath)} is missing runs.using`, { diagnostics: { field: 'runs.using', expected: 'declared-runtime', observed: 'missing' } });
  return match[1];
};

const compositeReferences = (root, actionPath) => {
  const content = readFileSync(path.join(actionPath, 'action.yml'), 'utf8');
  const references = [...content.matchAll(/\$\{GITHUB_ACTION_PATH\}\/([^"'\s]+)/g)]
    .map((match) => path.resolve(actionPath, match[1]));
  for (const reference of references) {
    const relative = path.relative(root, reference);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new DiagnosticError(`composite-reference-outside-repository: Composite Action ${path.basename(actionPath)} references a path outside the repository`, { diagnostics: { field: 'composite-reference', expected: 'inside-repository', observed: 'outside-repository' } });
    }
    if (!existsSync(reference)) {
      throw new DiagnosticError(`composite-reference-missing: Composite Action ${path.basename(actionPath)} is missing referenced path ${relative}`, { diagnostics: { field: 'composite-reference', expected: 'existing-path', observed: 'missing' } });
    }
  }
  return references.map((reference) => path.relative(root, reference));
};

export const collectActionMetadata = (root) => {
  const actionsRoot = path.join(root, 'actions');
  const entries = readdirSync(actionsRoot, { withFileTypes: true });
  const actions = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const actionPath = path.join(actionsRoot, entry.name);
      const runtime = runtimeFor(actionPath);
      const bundled = runtime.startsWith('node');
      if (!bundled && runtime !== 'composite') throw new DiagnosticError(`action-runtime-unsupported: Action ${entry.name} uses unsupported runtime ${runtime}`, { diagnostics: { field: 'runs.using', expected: 'node-or-composite', observed: 'unsupported' } });
      return {
        name: entry.name,
        path: actionPath,
        runtime,
        distPath: bundled ? path.relative(root, path.join(actionPath, 'dist')) : null,
        companionDistPaths: entry.name === 'ci-release-supplemental-asset' ? ['runtime/installer/dist'] : [],
      };
    });
  if (actions.length === 0) throw new DiagnosticError('action-inventory-empty: No Action directories were found', { diagnostics: { field: 'actions', expected: 'one-or-more', observed: 0 } });
  return actions;
};

export const collectActions = (root) => collectActionMetadata(root).map((action) => {
  for (const file of ['action.yml', 'README.md', ...(action.distPath ? bundledFiles : [])]) {
    if (!existsSync(path.join(action.path, file))) throw new DiagnosticError(`action-package-file-missing: Action ${action.name} is missing ${file}`, { diagnostics: { field: 'action-package', expected: file, observed: 'missing' } });
  }
  return { ...action, referencedPaths: action.distPath ? [] : compositeReferences(root, action.path) };
});

export const collectScriptBundleMetadata = (root) => [{
  name: 'rust-release-platform-manifest',
  path: path.join(root, 'runtime/rust-release'),
  distPath: 'runtime/rust-release/dist',
}];

export const collectScriptBundles = (root) => {
  const scriptPath = path.join(root, 'runtime/rust-release');
  for (const file of ['package.json', 'src/verify-platform-manifest.mjs', 'dist/index.mjs']) {
    if (!existsSync(path.join(scriptPath, file))) throw new DiagnosticError(`script-bundle-file-missing: Rust release scripts are missing ${file}`, { diagnostics: { field: 'script-bundle', expected: file, observed: 'missing' } });
  }
  return collectScriptBundleMetadata(root);
};

export const buildPlan = (root, actions, scriptBundles = [], { transpileOnly = false } = {}) => {
  const bundled = actions.filter((action) => action.distPath);
  const generatedDiagnostics = bundled.length ? ['runtime/diagnostics/failure.mjs', 'runtime/diagnostics/failure.d.mts'] : [];
  return [
  ...bundled.map((action) => ({ command: 'npm', args: ['ci', '--ignore-scripts'], cwd: action.path })),
  ...(bundled.length ? [{
    command: process.execPath,
    args: [path.join(bundled[0].path, 'node_modules/typescript/bin/tsc'),
      '--project', path.join(root, 'runtime/diagnostics/tsconfig.json'),
      '--typeRoots', path.join(bundled[0].path, 'node_modules/@types')],
    cwd: root,
  }] : []),
  ...bundled.map((action) => ({ command: 'npm', args: ['run', 'build', ...(transpileOnly ? ['--', '--transpile-only'] : [])], cwd: action.path })),
  ...scriptBundles.flatMap((bundle) => [
    { command: 'npm', args: ['ci', '--ignore-scripts'], cwd: bundle.path },
    { command: 'npm', args: ['run', 'build'], cwd: bundle.path },
  ]),
  {
    command: 'git',
    args: [
      'diff',
      '--exit-code',
      '--name-only',
      '--',
      ...generatedDiagnostics,
      ...actions.filter((action) => action.distPath).flatMap((action) => [action.distPath, ...(action.companionDistPaths ?? [])]),
      ...scriptBundles.map((bundle) => bundle.distPath),
    ],
    cwd: root,
    failure: 'dist-identity-mismatch',
  },
  ];
};

export const runPlan = (plan, execute = execFileSync) => {
  for (const step of plan) {
    try { execute(step.command, step.args, { cwd: step.cwd, stdio: 'inherit' }); } catch (error) {
      if (!step.failure) throw error;
      throw new DiagnosticError(`${step.failure}: Generated distribution differs from the committed files`, { cause: error, diagnostics: { field: 'dist', expected: 'committed-dist', observed: 'differs', evidence: 'stdout-changed-paths' } });
    }
  }
};

export const assertNoUntrackedDist = (root, actions, scriptBundles = [], execute = execFileSync) => {
  const distPaths = [
    ...(actions.some((action) => action.distPath) ? ['runtime/diagnostics/failure.mjs', 'runtime/diagnostics/failure.d.mts'] : []),
    ...actions.filter((action) => action.distPath).flatMap((action) => [action.distPath, ...(action.companionDistPaths ?? [])]),
    ...scriptBundles.map((bundle) => bundle.distPath),
  ];
  const output = execute(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', ...distPaths],
    { cwd: root, encoding: 'utf8' },
  );
  const untracked = String(output).trim();
  if (untracked) throw new DiagnosticError(`dist-untracked: Untracked distribution files were found:\n${untracked}`, { diagnostics: { field: 'tracked-dist', expected: 'tracked', observed: 'untracked', paths: untracked.split('\n') } });
};

export const assertTrackedReferences = (root, actions, execute = execFileSync) => {
  const referencedPaths = [...new Set(actions.flatMap((action) => action.referencedPaths ?? []))];
  if (referencedPaths.length === 0) return;
  try {
    execute(
      'git',
      ['ls-files', '--error-unmatch', '--', ...referencedPaths],
      { cwd: root, stdio: 'pipe' },
    );
  } catch {
    throw new DiagnosticError(`composite-reference-untracked: Composite Actions contain untracked referenced paths:\n${referencedPaths.join('\n')}`, { diagnostics: { field: 'composite-reference', expected: 'tracked', observed: 'untracked' } });
  }
};

export const checkActionDist = (root = defaultRoot, { transpileOnly = false } = {}) => {
  const diagnostic = new FailureContext('repository-action-distribution', 'check-distribution');
  try {
  diagnostic.at('action-metadata', { input: 'action-and-runtime-source-inventory' });
  const actions = collectActions(root);
  const scriptBundles = collectScriptBundles(root);
  diagnostic.confirmed();
  diagnostic.at('execution-closure', { input: 'composite-entrypoints' });
  assertTrackedReferences(root, actions);
  diagnostic.confirmed();
  diagnostic.at('build-and-identity', { input: 'source-and-dist', actions: actions.length, bundles: scriptBundles.length });
  diagnostic.writeState = 'generated-dist-may-be-partial';
  runPlan(buildPlan(root, actions, scriptBundles, { transpileOnly }));
  diagnostic.confirmed();
  diagnostic.at('distribution-inventory', { input: 'tracked-dist' });
  assertNoUntrackedDist(root, actions, scriptBundles);
  console.log(`Distribution is synchronized (${actions.length} actions, ${scriptBundles.length} script bundle).`);
  } catch (error) { throw diagnostic.capture(error); }
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
      const args = process.argv.slice(2);
      if (args.length > 1 || args.length === 1 && args[0] !== '--transpile-only') {
        throw new DiagnosticError('action-dist-arguments-invalid: Expected no arguments or --transpile-only');
      }
      checkActionDist(defaultRoot, { transpileOnly: args.length === 1 });
    } catch (error) {
    new FailureContext('repository-action-distribution', 'check-distribution').report(error);
    completeFailure(safeErrorReason(error));
  }
}
