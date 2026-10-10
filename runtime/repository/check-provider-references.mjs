import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { verifyImplementationBinding } from './verify-implementation-binding.mjs';

export const registryPath = 'skills/ci-github/references/ci-github-preset-assets.reference.yml';
export const parseYaml = (text, relative) => {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${relative}: ${document.errors.map((error) => error.message).join('; ')}`);
  return document;
};

export function workflowReferences(text, relative) {
  const value = parseYaml(text, relative).toJS();
  return relative.startsWith('.github/workflows/') || relative.startsWith('workflows/')
    ? Object.entries(value?.jobs ?? {}).flatMap(([id, job]) => [
      ...(Object.hasOwn(job, 'uses') ? [{ location: `jobs.${id}`, uses: job.uses }] : []),
      ...(job.steps ?? []).flatMap((step, index) => Object.hasOwn(step, 'uses') ? [{ location: `jobs.${id}.steps[${index}]`, uses: step.uses, step, job }] : []),
    ])
    : (value?.runs?.steps ?? []).flatMap((step, index) => Object.hasOwn(step, 'uses') ? [{ location: `runs.steps[${index}]`, uses: step.uses, step }] : []);
}

export function checkProviderReferences(text, relative, approved, firstParty) {
  const references = workflowReferences(text, relative);
  const diagnostics = [];
  for (const { location, uses } of references) {
    if (typeof uses === 'string' && (uses.startsWith('./') || uses.startsWith('docker://'))) continue;
    const match = typeof uses === 'string' && uses.match(/^([^@\s]+)@([0-9a-f]{40})$/);
    if (!match) diagnostics.push(`${relative}:${location}: external uses must have a full lowercase commit SHA`);
    else if (firstParty && match[1].startsWith(`${firstParty.repository}/actions/`)) {
      if (match[2] !== firstParty.exactRef) diagnostics.push(`${relative}:${location}: first-party uses does not match the registry Action binding`);
    } else if (!match[1].startsWith('a3-suite/a3-ci-github/') && approved.get(match[1]) !== match[2]) {
      diagnostics.push(`${relative}:${location}: external uses is not a registry-approved provider pin`);
    }
  }
  return diagnostics;
}

export function repositorySnapshot(root, staged = false) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const before = staged ? git('write-tree') : undefined;
  const rawRead = (relative) => staged
    ? execFileSync('git', ['show', `${before}:${relative}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(path.join(root, relative), 'utf8');
  const contents = new Map();
  const read = (relative) => {
    if (!contents.has(relative)) contents.set(relative, rawRead(relative));
    return contents.get(relative);
  };
  const paths = staged ? git('ls-tree', '-r', '--name-only', '-z', before).split('\0').filter(Boolean) : (() => {
    const scan = (directory) => readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
      ? scan(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
    return ['.github/workflows', 'actions', 'workflows'].flatMap((directory) => {
      try { return directory === 'workflows' ? scan(directory) : directory === 'actions'
        ? readdirSync(path.join(root, directory), { withFileTypes: true }).filter((entry) => entry.isDirectory())
          .flatMap((entry) => readdirSync(path.join(root, directory, entry.name)).map((name) => `${directory}/${entry.name}/${name}`))
        : readdirSync(path.join(root, directory)).map((name) => `${directory}/${name}`); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    });
  })();
  const providerTargets = paths.filter((relative) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(relative) || /^actions\/[^/]+\/action\.ya?ml$/.test(relative));
  for (const name of ['ci-quality', 'ci-quality-platforms', 'ci-package-preparation', 'ci-release-publication', 'ci-package-publication']) {
    if (!providerTargets.includes(`.github/workflows/${name}.yml`)) throw new Error(`Missing provider callee: ${name}`);
  }
  const registry = parseDocument(read(registryPath));
  if (registry.errors.length) throw new Error('Invalid provider registry YAML');
  const value = registry.toJS();
  const entries = value.providerActions.entries;
  const approved = new Map(entries.map((entry) => [entry.action, entry.commitSha]));
  if (approved.size !== entries.length || entries.some((entry) => !/^[0-9a-f]{40}$/.test(entry.commitSha))) throw new Error('Invalid provider pin registry');
  const canonicalTargets = paths.filter((relative) => /^workflows\/.+\.ya?ml$/.test(relative));
  const targets = [...providerTargets, ...canonicalTargets];
  return { read, registry: value, approved, targets, providerTargets, before, assertUnchanged: () => {
    if (staged && git('write-tree') !== before) throw new Error('Staged snapshot changed during provider validation');
    if (!staged && [...contents].some(([relative, content]) => rawRead(relative) !== content)) throw new Error('Worktree snapshot changed during provider validation');
  } };
}

export function checkRepository(root, staged = false, options = {}) {
  const snapshot = repositorySnapshot(root, staged);
  const binding = snapshot.registry.actionization.implementationSource;
  if (!/^[0-9a-f]{40}$/.test(binding.exactRef) || binding.repository !== 'a3-suite/a3-ci-github') throw new Error('Invalid first-party Action binding');
  const diagnostics = snapshot.providerTargets.flatMap((relative) => checkProviderReferences(snapshot.read(relative), relative, snapshot.approved, binding));
  const connection = checkActionReferences(root, snapshot, options);
  diagnostics.push(...connection.diagnostics);
  snapshot.assertUnchanged();
  return { checkedTargets: snapshot.targets.length, diagnostics, interfaceDiagnostics: connection.interfaceDiagnostics, actionReferences: connection.references, implementationBinding: connection.implementationBinding, snapshot };
}

function actionEntrypointDiagnostics(root, actionPath, sha, action, closureRoots) {
  const runs = action.runs ?? {};
  let entries;
  if (/^node[0-9]+$/.test(runs.using)) entries = ['main', ...['pre', 'post'].filter((key) => Object.hasOwn(runs, key))].map((key) => runs[key]);
  else if (runs.using === 'composite') {
    const pattern = /(?:\$\{GITHUB_ACTION_PATH\}|\$GITHUB_ACTION_PATH\b|\$\{\{\s*github\.action_path\s*\}\})["']?\/([a-zA-Z0-9._/-]+)(?:["'](?=[\s;|&)]|$)|(?=[\s;|&)]|$))/g;
    entries = (runs.steps ?? []).flatMap((step) => [...(step.run ?? '').matchAll(pattern)].map((match) => match[1]));
    if ((runs.steps ?? []).some((step) => /\$(?:\{?GITHUB_ACTION_PATH\b|\{\{\s*github\.action_path\b)/.test((step.run ?? '').replace(pattern, '')))) return [`${actionPath}@${sha}: unresolved Composite Action entrypoint`];
  }
  else return [`${actionPath}@${sha}: unsupported Action entrypoint runtime`];
  return entries.flatMap((entry) => {
    if (typeof entry !== 'string' || !entry || path.posix.isAbsolute(entry)) return [`${actionPath}@${sha}: invalid Action entrypoint`];
    const relative = path.posix.normalize(`${actionPath}/${entry}`);
    if (!closureRoots.some((directory) => relative.startsWith(`${directory}/`))) return [`${actionPath}@${sha}: Action entrypoint outside execution closure: ${entry}`];
    const object = execFileSync('git', ['ls-tree', '--format=%(objectmode) %(objecttype)', sha, '--', `:(literal)${relative}`], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
    return /^(100644|100755) blob$/.test(object) ? [] : [`${actionPath}@${sha}: Action entrypoint is missing or not a regular file: ${entry}`];
  });
}

export function checkActionReferences(root, snapshot, options = {}) {
  const binding = snapshot.registry.actionization.implementationSource;
  const diagnostics = [];
  const interfaceDiagnostics = [];
  const references = snapshot.targets.flatMap((relative) => workflowReferences(snapshot.read(relative), relative)
    .filter((reference) => typeof reference.uses === 'string' && reference.uses.startsWith(`${binding.repository}/actions/`))
    .map((reference) => ({ ...reference, relative })));
  const actionPaths = references.flatMap(({ uses }) => /^a3-suite\/a3-ci-github\/(actions\/[a-z0-9-]+)@[0-9a-f]{40}$/.exec(uses)?.[1] ?? []);
  const closureRoots = [...new Set([...actionPaths, 'runtime'])];
  const metadata = new Map();
  for (const reference of references) {
    const match = /^a3-suite\/a3-ci-github\/(actions\/[a-z0-9-]+)@([0-9a-f]{40})$/.exec(reference.uses);
    if (!match) {
      diagnostics.push(`${reference.relative}:${reference.location}: invalid first-party Action path`);
      continue;
    }
    if (match[2] !== binding.exactRef) {
      if (reference.relative.startsWith('workflows/')) diagnostics.push(`${reference.relative}:${reference.location}: first-party uses does not match the registry Action binding`);
      continue;
    }
    const [, actionPath, sha] = match;
    const target = snapshot.registry.actionization.targets.find((entry) => entry.actionPath === actionPath && entry.status === 'available');
    if (!target) { diagnostics.push(`${reference.relative}:${reference.location}: first-party Action is not registered as available`); continue; }
    if (!metadata.has(reference.uses)) {
      const text = execFileSync('git', ['show', `${sha}:${actionPath}/action.yml`], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
      metadata.set(reference.uses, parseYaml(text, `${sha}:${actionPath}/action.yml`).toJS());
      diagnostics.push(...actionEntrypointDiagnostics(root, actionPath, sha, metadata.get(reference.uses), closureRoots));
    }
    const action = metadata.get(reference.uses);
    const inputs = reference.step?.with ?? {};
    for (const input of Object.keys(inputs)) if (!Object.hasOwn(action.inputs ?? {}, input)) interfaceDiagnostics.push(`${reference.relative}:${reference.location}: undeclared Action input ${input}`);
    for (const [input, contract] of Object.entries(action.inputs ?? {})) {
      if (contract.required === true && (!Object.hasOwn(inputs, input) || inputs[input] === '' || inputs[input] === null) && !Object.hasOwn(contract, 'default')) interfaceDiagnostics.push(`${reference.relative}:${reference.location}: missing required Action input ${input}`);
    }
    if (reference.step?.id && reference.job) {
      const strings = (value) => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
      for (const value of strings(reference.job)) for (const template of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) for (const expression of template[1].matchAll(/steps\.([\w-]+)\.outputs(?:\.([\w-]+)|\[['"]([\w-]+)['"]\])/g)) {
        if (expression[1] === reference.step.id && !Object.hasOwn(action.outputs ?? {}, expression[2] ?? expression[3])) interfaceDiagnostics.push(`${reference.relative}:${reference.location}: undeclared Action output ${expression[2] ?? expression[3]}`);
      }
    }
    const revision = reference.step?.env?.A3_INSTALLER_PROVIDER_REVISION;
    if (revision !== undefined && revision !== sha) diagnostics.push(`${reference.relative}:${reference.location}: installer provider revision differs from the Action SHA`);
  }
  let implementationBinding;
  if (actionPaths.length) {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
    let sourceRevision;
    let sourceTree;
    if (options.candidate) {
      sourceRevision = git('rev-parse', 'HEAD');
      sourceTree = snapshot.before ?? git('rev-parse', 'HEAD^{tree}');
      if (!snapshot.before && git('status', '--porcelain', '--untracked-files=all', '--', ...new Set([...actionPaths, 'runtime']))) throw new Error('implementation-candidate-execution-assets-dirty');
      if (snapshot.read('VERSION').trim() !== git('show', `${sourceTree}:VERSION`)) throw new Error('implementation-candidate-version-dirty');
    } else {
      const tag = options.releaseTag ?? binding.releaseTag;
      if (tag !== binding.releaseTag) throw new Error('implementation-binding-release-tag-mismatch');
      if (git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag') throw new Error('implementation-binding-annotated-tag-required');
      sourceRevision = git('rev-parse', `refs/tags/${tag}^{commit}`);
      if (options.releaseTag && (snapshot.before || sourceRevision !== git('rev-parse', 'HEAD'))) throw new Error('implementation-publication-source-mismatch');
      if (options.releaseTag && git('status', '--porcelain', '--untracked-files=all', '--', 'VERSION', registryPath, ...snapshot.targets, ...new Set([...actionPaths, 'runtime']))) throw new Error('implementation-publication-source-dirty');
      sourceTree = sourceRevision;
    }
    implementationBinding = verifyImplementationBinding(root, binding, actionPaths, { sourceRevision, sourceTree });
  } else if (options.releaseTag || options.candidate) throw new Error('implementation-binding-references-missing');
  return { diagnostics, interfaceDiagnostics, references, implementationBinding };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    const flags = new Set();
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (flags.has(arg) || !['--staged', '--contracts', '--preparation', '--candidate', '--release-tag'].includes(arg)) throw new Error('Usage: node runtime/repository/check-provider-references.mjs [--staged] [--contracts] [--preparation|--candidate] or --contracts --release-tag <vX.Y.Z>');
      flags.add(arg);
      if (arg === '--release-tag') { options.releaseTag = args[++index]; if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(options.releaseTag ?? '')) throw new Error('Expected an exact release tag'); }
    }
    options.candidate = flags.has('--candidate');
    if (flags.has('--preparation') && (!flags.has('--contracts') || options.candidate) || options.releaseTag && (!flags.has('--contracts') || options.candidate || flags.has('--staged') || flags.has('--preparation'))) throw new Error('Invalid provider reference validation mode');
    const result = checkRepository(process.cwd(), flags.has('--staged'), options);
    const report = { checkedTargets: result.checkedTargets, diagnostics: result.diagnostics, interfaceDiagnostics: result.interfaceDiagnostics,
      implementationBinding: result.implementationBinding,
      implementationSourceRevision: result.implementationBinding?.implementationSourceRevision,
      implementationBindingStatus: result.implementationBinding?.implementationBindingStatus };
    if (args.includes('--contracts') && !result.diagnostics.length) {
      const { verifyActionReferenceContracts } = await import('./verify-action-reference-contracts.mjs');
      report.connection = verifyActionReferenceContracts(process.cwd(), result.actionReferences, result.snapshot);
      report.connection.diagnostics.push(...result.interfaceDiagnostics);
      const actionization = result.snapshot.registry.actionization;
      const pending = actionization.availabilityGate.status === 'pending-release'
        && actionization.targets.every((target) => target.status === 'pending-release');
      report.preparationOnly = args.includes('--preparation') && pending && report.connection.diagnostics.length > 0;
    }
    result.snapshot.assertUnchanged();
    if (!flags.has('--contracts') && report.implementationBinding) {
      report.implementationBindingStatus = 'unverified';
      report.implementationBinding.implementationBindingStatus = 'unverified';
    }
    if (result.diagnostics.length || result.interfaceDiagnostics.length || report.connection?.diagnostics.length) {
      report.implementationBindingStatus = 'rejected';
      if (report.implementationBinding) report.implementationBinding.implementationBindingStatus = 'rejected';
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = result.diagnostics.length || (report.connection?.diagnostics.length ?? result.interfaceDiagnostics.length) && !report.preparationOnly ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
