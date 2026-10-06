import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export function checkProviderReferences(text, relative, approved) {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${relative}: ${document.errors.map((error) => error.message).join('; ')}`);
  const value = document.toJS();
  const references = relative.startsWith('.github/workflows/')
    ? Object.entries(value?.jobs ?? {}).flatMap(([id, job]) => [
      ...(Object.hasOwn(job, 'uses') ? [{ location: `jobs.${id}`, uses: job.uses }] : []),
      ...(job.steps ?? []).flatMap((step, index) => Object.hasOwn(step, 'uses') ? [{ location: `jobs.${id}.steps[${index}]`, uses: step.uses }] : []),
    ])
    : (value?.runs?.steps ?? []).flatMap((step, index) => Object.hasOwn(step, 'uses') ? [{ location: `runs.steps[${index}]`, uses: step.uses }] : []);
  const diagnostics = [];
  for (const { location, uses } of references) {
    if (typeof uses === 'string' && (uses.startsWith('./') || uses.startsWith('docker://'))) continue;
    const match = typeof uses === 'string' && uses.match(/^([^@\s]+)@([0-9a-f]{40})$/);
    if (!match) diagnostics.push(`${relative}:${location}: external uses must have a full lowercase commit SHA`);
    // First-party contracts and availability remain owned by preset preflight.
    else if (!match[1].startsWith('a3-suite/a3-ci-github/') && approved.get(match[1]) !== match[2]) {
      diagnostics.push(`${relative}:${location}: external uses is not a registry-approved provider pin`);
    }
  }
  return diagnostics;
}

export function checkRepository(root, staged = false) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const before = staged ? git('write-tree') : undefined;
  const read = (relative) => staged
    ? execFileSync('git', ['show', `${before}:${relative}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(path.join(root, relative), 'utf8');
  const paths = staged ? git('ls-tree', '-r', '--name-only', '-z', before).split('\0').filter(Boolean) : [
    ...readdirSync(path.join(root, '.github/workflows')).map((name) => `.github/workflows/${name}`),
    ...readdirSync(path.join(root, 'actions'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .flatMap((entry) => readdirSync(path.join(root, 'actions', entry.name)).map((name) => `actions/${entry.name}/${name}`)),
  ];
  const targets = paths.filter((relative) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(relative) || /^actions\/[^/]+\/action\.ya?ml$/.test(relative));
  for (const name of ['ci-quality', 'ci-quality-platforms', 'ci-package-preparation', 'ci-release-publication', 'ci-package-publication']) {
    if (!targets.includes(`.github/workflows/${name}.yml`)) throw new Error(`Missing provider callee: ${name}`);
  }
  const registry = parseDocument(read('skills/ci-github/references/ci-github-preset-assets.reference.yml'));
  if (registry.errors.length) throw new Error('Invalid provider registry YAML');
  const entries = registry.toJS().providerActions.entries;
  const approved = new Map(entries.map((entry) => [entry.action, entry.commitSha]));
  if (approved.size !== entries.length || entries.some((entry) => !/^[0-9a-f]{40}$/.test(entry.commitSha))) throw new Error('Invalid provider pin registry');
  const diagnostics = targets.flatMap((relative) => checkProviderReferences(read(relative), relative, approved));
  if (staged && git('write-tree') !== before) throw new Error('Staged snapshot changed during provider validation');
  return { checkedTargets: targets.length, diagnostics };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--staged')) throw new Error('Usage: node runtime/repository/check-provider-references.mjs [--staged]');
    const result = checkRepository(process.cwd(), args.includes('--staged'));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.diagnostics.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
