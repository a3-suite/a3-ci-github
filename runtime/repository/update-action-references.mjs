import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScalar, visit } from 'yaml';
import { checkActionReferences, parseYaml, registryPath, repositorySnapshot } from './check-provider-references.mjs';
import { verifyActionReferenceContracts } from './verify-action-reference-contracts.mjs';

export function planActionReferenceUpdate(root, tag, sha) {
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag)) throw new Error('Expected an exact vX.Y.Z release tag');
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('Expected a full implementation commit SHA');
  const snapshot = repositorySnapshot(root);
  const binding = snapshot.registry.actionization.implementationSource;
  if (binding.repository !== 'a3-suite/a3-ci-github') throw new Error('Unexpected Action binding repository');
  const before = new Map();
  const after = new Map();
  const substitute = (text, updates) => updates.sort((left, right) => right.node.range[0] - left.node.range[0]).reduce((result, { node, value }) => {
    if (!isScalar(node) || !node.range) throw new Error('Action binding scalar is unavailable');
    const original = text.slice(node.range[0], node.range[1]);
    const replacement = original.startsWith('"') || original.startsWith("'") ? JSON.stringify(value) : value;
    return result.slice(0, node.range[0]) + replacement + result.slice(node.range[1]);
  }, text);
  for (const relative of [registryPath, ...snapshot.targets]) {
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
          if (!match || ![binding.exactRef, sha].includes(match[2])) throw new Error(`${relative}: unexpected first-party reference drift`);
          updates.push({ node: pair.value, value: `${match[1]}@${sha}` });
        }
        if (pair.key?.value === 'A3_INSTALLER_PROVIDER_REVISION') {
          if (![binding.exactRef, sha].includes(pair.value?.value)) throw new Error(`${relative}: unexpected installer revision drift`);
          updates.push({ node: pair.value, value: sha });
        }
      } });
    }
    const updated = substitute(text, updates);
    before.set(relative, text);
    after.set(relative, updated);
  }
  const candidate = { ...snapshot, read: (relative) => after.get(relative) ?? snapshot.read(relative), registry: parseYaml(after.get(registryPath), registryPath).toJS() };
  const references = checkActionReferences(root, candidate, { candidate: true });
  if (references.diagnostics.length || references.interfaceDiagnostics.length) throw new Error([...references.diagnostics, ...references.interfaceDiagnostics].join('\n'));
  const connection = verifyActionReferenceContracts(root, references.references, candidate);
  if (connection.diagnostics.length) throw new Error(connection.diagnostics.join('\n'));
  snapshot.assertUnchanged();
  return { tag, sha, before, after, connection, snapshot: candidate, implementationBinding: references.implementationBinding, changedPaths: [...after.keys()].filter((relative) => before.get(relative) !== after.get(relative)) };
}

export function applyActionReferenceUpdate(root, plan) {
  for (const relative of plan.changedPaths) {
    const parts = relative.split('/');
    for (let index = 1; index <= parts.length; index += 1) if (lstatSync(path.join(root, ...parts.slice(0, index))).isSymbolicLink()) throw new Error(`Refusing symlink update: ${relative}`);
    if (readFileSync(path.join(root, relative), 'utf8') !== plan.before.get(relative)) throw new Error(`Action reference input changed: ${relative}`);
  }
  plan.snapshot.assertUnchanged();
  const checked = checkActionReferences(root, plan.snapshot, { candidate: true });
  if (checked.diagnostics.length || checked.interfaceDiagnostics.length || checked.implementationBinding.sourceRevision !== plan.implementationBinding.sourceRevision || checked.implementationBinding.sourceTree !== plan.implementationBinding.sourceTree) throw new Error('Action reference candidate changed after planning');
  for (const relative of plan.changedPaths) writeFileSync(path.join(root, relative), plan.after.get(relative));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 5 || !['--check', '--write'].includes(args[0]) || args[1] !== '--tag' || args[3] !== '--implementation-sha') throw new Error('Usage: node runtime/repository/update-action-references.mjs (--check|--write) --tag vX.Y.Z --implementation-sha <full SHA>');
    const plan = planActionReferenceUpdate(process.cwd(), args[2], args[4]);
    if (args[0] === '--write') applyActionReferenceUpdate(process.cwd(), plan);
    process.stdout.write(`${JSON.stringify({ tag: plan.tag, sha: plan.sha, changedPaths: plan.changedPaths, connection: plan.connection, implementationBinding: plan.implementationBinding }, null, 2)}\n`);
    process.exitCode = args[0] === '--check' && plan.changedPaths.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
