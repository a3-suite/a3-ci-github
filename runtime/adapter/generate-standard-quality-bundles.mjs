import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = createRequire(path.join(root, 'runtime/preset/package.json'))('yaml');

export const generateStandardQualityBundles = ({ repositoryRoot = root, check = false } = {}) => {
  const inventory = yaml.parse(fs.readFileSync(path.join(repositoryRoot, 'skills/ci-github/references/ci-script-assets.reference.yml'), 'utf8'));
  const sourceRoot = fs.realpathSync(path.join(repositoryRoot, 'runtime/adapter/bundles'));
  const repository = fs.realpathSync(repositoryRoot);
  const relative = path.relative(repository, sourceRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('standard-quality-source-outside-repository');
  const ids = new Set();
  const entries = inventory.adapterBundles.map((bundle) => {
    const sourcePath = bundle.source?.path;
    if (bundle.delivery !== 'action' || bundle.source?.skill !== undefined
      || typeof sourcePath !== 'string' || !/^runtime\/adapter\/bundles\/[a-z0-9][a-z0-9-]*\.yml$/.test(sourcePath)) {
      throw new Error(`standard-quality-source-contract-mismatch:${bundle.id}`);
    }
    const filename = fs.realpathSync(path.join(repositoryRoot, sourcePath));
    if (path.dirname(filename) !== sourceRoot || !fs.statSync(filename).isFile()) throw new Error(`standard-quality-source-outside-repository:${bundle.id}`);
    const descriptor = fs.readFileSync(filename, 'utf8');
    const parsed = yaml.parse(descriptor);
    if (ids.has(bundle.id) || parsed.schemaVersion !== '1' || parsed.kind !== 'ci-adapter-bundle'
      || parsed.id !== bundle.id || parsed.owner !== 'ci-github' || parsed.provider !== 'provider-neutral'
      || parsed.copyable !== true || parsed.executionBoundary !== 'read-only' || parsed.sourceCheckout !== 'fixed-source'
      || !Array.isArray(parsed.assets) || parsed.assets.length !== 0
      || JSON.stringify(parsed.languageProfiles) !== JSON.stringify(bundle.languageProfiles)) {
      throw new Error(`standard-quality-source-contract-mismatch:${bundle.id}`);
    }
    ids.add(bundle.id);
    return { id: bundle.id, owner: parsed.owner, sourcePath,
      sha256: createHash('sha256').update(descriptor).digest('hex'), descriptor };
  });
  const output = path.join(repositoryRoot, 'runtime/adapter/standard-quality-bundles.generated.ts');
  const generated = `// Generated from repository-owned descriptors by generate-standard-quality-bundles.mjs.\nexport const STANDARD_QUALITY_BUNDLES = ${JSON.stringify(entries, null, 2)} as const;\n`;
  if (check) {
    if (fs.readFileSync(output, 'utf8') !== generated) throw new Error('standard-quality-generated-content-drift');
  } else fs.writeFileSync(output, generated);
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== '--check') throw new Error('standard-quality-generation-arguments-invalid: expected no arguments or --check');
  generateStandardQualityBundles({ check: args.includes('--check') });
}
