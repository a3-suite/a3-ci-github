import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = createRequire(path.join(root, 'runtime/preset/package.json'))('yaml');

export const generateStandardQualityBundles = ({ sourceRoot, revision, repositoryRoot = root, check = false }) => {
  if (!sourceRoot || !/^[a-f0-9]{40}$/.test(revision ?? '')) {
    throw new Error('standard-quality-generation-requires-source-root-and-full-revision');
  }
  const git = (...parameters) => execFileSync('git', ['-C', sourceRoot, ...parameters], { encoding: 'utf8' });
  const sourceRepository = 'https://github.com/izumilufty/a3-prompts';
  const ownerOrigins = new Set([
    sourceRepository, `${sourceRepository}.git`,
    'git@github.com:izumilufty/a3-prompts.git',
    'git@github.com-izumilufty:izumilufty/a3-prompts.git',
    'ssh://git@github.com/izumilufty/a3-prompts.git',
  ]);
  if (!ownerOrigins.has(git('remote', 'get-url', 'origin').trim())) throw new Error('standard-quality-source-repository-mismatch');
  if (git('rev-parse', `${revision}^{commit}`).trim() !== revision) throw new Error('standard-quality-source-revision-invalid');
  const inventory = yaml.parse(fs.readFileSync(path.join(repositoryRoot, 'skills/ci-github/references/ci-script-assets.reference.yml'), 'utf8'));
  const tracked = git('ls-tree', '-r', '--name-only', revision).trim().split('\n');
  const entries = inventory.adapterBundles.map((bundle) => {
    const suffix = `/${bundle.source.skill}/${bundle.source.path}`;
    const candidates = tracked.filter((entry) => entry.startsWith('skills/') && entry.endsWith(suffix));
    if (candidates.length !== 1) throw new Error(`standard-quality-source-not-unique:${bundle.id}`);
    const sourcePath = candidates[0];
    const descriptor = git('show', `${revision}:${sourcePath}`);
    const parsed = yaml.parse(descriptor);
    if (parsed.id !== bundle.id || parsed.owner !== bundle.source.skill || parsed.assets?.length !== 0
      || JSON.stringify(parsed.languageProfiles) !== JSON.stringify(bundle.languageProfiles)) {
      throw new Error(`standard-quality-source-contract-mismatch:${bundle.id}`);
    }
    return { id: bundle.id, owner: parsed.owner, sourceRepository,
      sourceRevision: revision, sourcePath, sha256: createHash('sha256').update(descriptor).digest('hex'), descriptor };
  });
  const output = path.join(repositoryRoot, 'runtime/adapter/standard-quality-bundles.generated.ts');
  const generated = `// Generated from fixed owner Git objects by generate-standard-quality-bundles.mjs.\nexport const STANDARD_QUALITY_BUNDLES = ${JSON.stringify(entries, null, 2)} as const;\n`;
  if (check) {
    if (fs.readFileSync(output, 'utf8') !== generated) throw new Error('standard-quality-generated-content-drift');
  } else fs.writeFileSync(output, generated);
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const argument = (name) => args[args.indexOf(name) + 1];
  if (!args.includes('--source-root') || !args.includes('--source-revision')) {
    throw new Error('standard-quality-generation-requires-source-root-and-full-revision');
  }
  generateStandardQualityBundles({ sourceRoot: argument('--source-root'), revision: argument('--source-revision'), check: args.includes('--check') });
}
