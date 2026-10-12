import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScalar, visit } from 'yaml';
import { checkActionReferences, parseYaml, registryPath, repositorySnapshot } from './check-provider-references.mjs';
import { verifyActionReferenceContracts } from './verify-action-reference-contracts.mjs';
import { completeFailure, DiagnosticError, FailureContext } from '../diagnostics/failure.mjs';

export function planActionReferenceUpdate(root, tag, sha, diagnostic = new FailureContext('repository-managed-source-integrity', 'action-reference-update')) {
  diagnostic.at('input-validation', { input: 'release-tag-and-implementation-sha' });
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag)) throw new DiagnosticError('Expected an exact vX.Y.Z release tag', { diagnosticCode: 'action-reference-tag-invalid', diagnostics: { field: 'release-tag', expected: 'vX.Y.Z', observed: 'invalid-format' } });
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new DiagnosticError('Expected a full implementation commit SHA', { diagnosticCode: 'action-reference-sha-invalid', diagnostics: { field: 'implementation-sha', expected: 'full-commit-sha', observed: 'invalid-format' } });
  diagnostic.confirmed();
  diagnostic.at('repository-snapshot', { input: registryPath, releaseTag: tag, implementationSha: sha });
  const snapshot = repositorySnapshot(root);
  const binding = snapshot.registry.actionization.implementationSource;
  if (binding.repository !== 'a3-suite/a3-ci-github') throw new DiagnosticError('Unexpected Action binding repository', { diagnosticCode: 'action-reference-repository-invalid' });
  const before = new Map();
  const after = new Map();
  const substitute = (text, updates) => updates.sort((left, right) => right.node.range[0] - left.node.range[0]).reduce((result, { node, value }) => {
    if (!isScalar(node) || !node.range) throw new DiagnosticError('Action binding scalar is unavailable', { diagnosticCode: 'action-reference-scalar-unavailable' });
    const original = text.slice(node.range[0], node.range[1]);
    const replacement = original.startsWith('"') || original.startsWith("'") ? JSON.stringify(value) : value;
    return result.slice(0, node.range[0]) + replacement + result.slice(node.range[1]);
  }, text);
  for (const relative of [registryPath, ...snapshot.targets]) {
    diagnostic.at('reference-projection', { input: relative });
    const text = snapshot.read(relative);
    const document = parseYaml(text, relative);
    const updates = [];
    if (relative === registryPath) {
      updates.push({ node: document.getIn(['actionization', 'implementationSource', 'releaseTag'], true), value: tag });
      updates.push({ node: document.getIn(['actionization', 'implementationSource', 'exactRef'], true), value: sha });
    } else {
      visit(document, { Pair(_key, pair) {
        if (pair.key?.value === 'uses' && typeof pair.value?.value === 'string' && pair.value.value.startsWith(`${binding.repository}/actions/`)) {
          const match = /^(a3-suite\/a3-ci-github\/actions\/[a-z0-9-]+)@([0-9a-f]{40})$/.exec(pair.value.value);
          if (!match || ![binding.exactRef, sha].includes(match[2])) throw new DiagnosticError(`${relative}: unexpected first-party reference drift`, { diagnosticCode: 'action-reference-drift' });
          updates.push({ node: pair.value, value: `${match[1]}@${sha}` });
        }
        if (pair.key?.value === 'A3_INSTALLER_PROVIDER_REVISION') {
          if (![binding.exactRef, sha].includes(pair.value?.value)) throw new DiagnosticError(`${relative}: unexpected installer revision drift`, { diagnosticCode: 'installer-reference-drift' });
          updates.push({ node: pair.value, value: sha });
        }
      } });
    }
    const updated = substitute(text, updates);
    before.set(relative, text);
    after.set(relative, updated);
  }
  const candidate = { ...snapshot, read: (relative) => after.get(relative) ?? snapshot.read(relative), registry: parseYaml(after.get(registryPath), registryPath).toJS() };
  diagnostic.confirmed();
  diagnostic.at('implementation-binding', { input: 'candidate-registry-and-fixed-action-objects' });
  const references = checkActionReferences(root, candidate, { candidate: true });
  if (references.diagnostics.length || references.interfaceDiagnostics.length) throw new DiagnosticError([...references.diagnostics, ...references.interfaceDiagnostics].join('\n'), { diagnosticCode: 'action-reference-contract-rejected' });
  diagnostic.confirmed();
  diagnostic.at('connection-contracts', { input: 'fixed-action-entrypoints' });
  const connection = verifyActionReferenceContracts(root, references.references, candidate);
  if (connection.diagnostics.length) throw new DiagnosticError(connection.diagnostics.join('\n'), { diagnosticCode: 'action-reference-connection-rejected' });
  diagnostic.confirmed();
  diagnostic.at('snapshot-recheck', { input: 'reference-update-inputs' });
  snapshot.assertUnchanged();
  diagnostic.confirmed();
  return { tag, sha, before, after, connection, snapshot: candidate, implementationBinding: references.implementationBinding, changedPaths: [...after.keys()].filter((relative) => before.get(relative) !== after.get(relative)) };
}

export function applyActionReferenceUpdate(root, plan, diagnostic = new FailureContext('repository-managed-source-integrity', 'action-reference-update')) {
  diagnostic.at('write-preconditions', { input: 'planned-reference-update' });
  for (const relative of plan.changedPaths) {
    const parts = relative.split('/');
    for (let index = 1; index <= parts.length; index += 1) if (lstatSync(path.join(root, ...parts.slice(0, index))).isSymbolicLink()) throw new DiagnosticError(`Refusing symlink update: ${relative}`, { diagnosticCode: 'action-reference-symlink-rejected' });
    if (readFileSync(path.join(root, relative), 'utf8') !== plan.before.get(relative)) throw new DiagnosticError(`Action reference input changed: ${relative}`, { diagnosticCode: 'action-reference-input-changed' });
  }
  plan.snapshot.assertUnchanged();
  const checked = checkActionReferences(root, plan.snapshot, { candidate: true });
  if (checked.diagnostics.length || checked.interfaceDiagnostics.length || checked.implementationBinding.sourceRevision !== plan.implementationBinding.sourceRevision || checked.implementationBinding.sourceTree !== plan.implementationBinding.sourceTree) throw new DiagnosticError('Action reference candidate changed after planning', { diagnosticCode: 'action-reference-candidate-changed' });
  diagnostic.confirmed();
  for (const relative of plan.changedPaths) {
    diagnostic.at('reference-write', { output: relative });
    diagnostic.writeState = 'local-references-may-be-partial';
    writeFileSync(path.join(root, relative), plan.after.get(relative));
    diagnostic.confirmed();
  }
  if (plan.changedPaths.length) diagnostic.writeState = 'local-references-updated';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const diagnostic = new FailureContext('repository-managed-source-integrity', 'action-reference-update');
  diagnostic.at('input-validation', { input: 'arguments' });
  try {
    const args = process.argv.slice(2);
    if (args.length !== 5 || !['--check', '--write'].includes(args[0]) || args[1] !== '--tag' || args[3] !== '--implementation-sha') throw new DiagnosticError('Usage: node runtime/repository/update-action-references.mjs (--check|--write) --tag vX.Y.Z --implementation-sha <full SHA>', { diagnosticCode: 'action-reference-arguments-invalid', diagnostics: { field: 'arguments', expected: 'check-or-write-with-release-tag-and-full-sha', observed: 'invalid-shape' } });
    const plan = planActionReferenceUpdate(process.cwd(), args[2], args[4], diagnostic);
    if (args[0] === '--write') applyActionReferenceUpdate(process.cwd(), plan, diagnostic);
    diagnostic.at('result-output', { output: 'stdout-reference-update-plan' });
    process.stdout.write(`${JSON.stringify({ tag: plan.tag, sha: plan.sha, changedPaths: plan.changedPaths, connection: plan.connection, implementationBinding: plan.implementationBinding }, null, 2)}\n`);
    process.exitCode = args[0] === '--check' && plan.changedPaths.length ? 1 : 0;
  } catch (error) {
    process.exitCode = 2;
    const reason = diagnostic.report(error);
    completeFailure(reason, 2);
  }
}
