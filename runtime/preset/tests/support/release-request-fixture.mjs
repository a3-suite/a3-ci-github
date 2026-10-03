import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const loadReleaseRequestFixtureModel = ({ repositoryRoot, runtimeRoot }) => {
  const requireFromRuntime = createRequire(path.join(path.resolve(runtimeRoot), 'package.json'));
  const { parse } = requireFromRuntime('yaml');
  const registryPath = path.join(
    repositoryRoot,
    'skills/ci-github/references/ci-github-preset-assets.reference.yml',
  );
  const registry = parse(readFileSync(registryPath, 'utf8'));
  const providerActions = registry.providerActions ?? {};
  const pinFields = providerActions.pinCompanion?.fields ?? [];
  const actionPins = new Map();
  const pinLines = [];
  for (const entry of providerActions.entries ?? []) {
    if (!entry.action || !entry.commitSha) continue;
    actionPins.set(entry.action, entry.commitSha);
    pinLines.push(`${entry.action}:`);
    for (const field of pinFields) pinLines.push(`  ${field}: ${entry[field] ?? ''}`);
  }
  const preset = registry.registry.presets.find((entry) => entry.id === 'release-request');
  if (!preset) throw new Error('release-request preset must be registered');
  const placeholders = new Map([
    ['<commit-sha>', 'a'.repeat(40)],
    ['<release-tag-pattern>', 'v*'],
    ['<versioned-runner>', 'ubuntu-24.04'],
  ]);
  const configureWorkflow = (text) => text
    .replace(/uses: ([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*)@<commit-sha>/g, (match, target) => {
      const action = target.split('/').slice(0, 2).join('/');
      const pin = actionPins.get(action);
      return pin ? `uses: ${target}@${pin}` : match;
    })
    .replace(/<[A-Za-z][A-Za-z0-9._-]*>/g, (placeholder) => placeholders.get(placeholder) ?? 'configured');

  return {
    actionPins,
    configureWorkflow,
    pinDocument: `${pinLines.join('\n')}\n`,
    pinPath: providerActions.pinCompanion?.path ?? '.ci/provider-action-pins.yml',
    preset,
    sha256,
  };
};

export const writeReleaseRequestFixture = ({ repositoryRoot, root, model }) => {
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  const canonical = readFileSync(
    path.join(repositoryRoot, 'workflows/release/release-request-tag.yml'),
    'utf8',
  );
  writeFileSync(
    path.join(root, '.github/workflows/release-request-tag.yml'),
    model.configureWorkflow(canonical),
  );
  mkdirSync(path.dirname(path.join(root, model.pinPath)), { recursive: true });
  writeFileSync(path.join(root, model.pinPath), model.pinDocument);
};

export const snapshotTree = (root, relative = '') => Object.fromEntries(
  readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      return [[`${child}${path.sep}`, 'directory'], ...Object.entries(snapshotTree(root, child))];
    }
    if (entry.isSymbolicLink()) return [[child, `symlink:${readlinkSync(path.join(root, child))}`]];
    return [[child, sha256(readFileSync(path.join(root, child)))]];
  }),
);
