import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LIMITS, canonicalJson, equal, fail, hashFile, hex, readRecord, safePath, sha256, text } from './io';
import { validateSnapshot } from './snapshot';

export type SupplementalOptionsType = {
  operation: string; sourceRoot: string; authorityPath: string; snapshotPath: string;
  standardBuildRoot: string; supplementalBuildRoot?: string; outputDirectory: string;
};

const relativePath = (value: string): string => {
  text(value, 'path-invalid');
  if (path.isAbsolute(value) || value.includes('\\')
    || value.split('/').some((part) => !part || part === '.' || part === '..')) fail('path-invalid');
  return value;
};
const overlaps = (left: string, right: string): boolean => left === right
  || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
// realpath can retain case aliases; disjointness must compare filesystem identities.
const fileIdentity = (file: string): string => {
  const { dev, ino } = fs.statSync(file, { bigint: true });
  return `${dev}:${ino}`;
};
const ancestorIdentities = (directory: string, root: string): string[] => {
  const result: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    result.push(fileIdentity(current));
    if (current === root || path.dirname(current) === current) return result;
  }
};
const checkoutSha = (root: string): string => {
  try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return fail('source-identity-mismatch'); }
};
const treeDigest = (root: string): string => {
  let count = 0;
  let bytes = 0;
  const entries: unknown[] = [['.', fs.statSync(root).mode, fileIdentity(root)]];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (++count > LIMITS.assets * 4) fail('input-size-invalid');
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('file-kind-invalid');
      const relative = path.relative(root, filename);
      if (stat.isDirectory()) { entries.push([relative, 'directory', stat.mode]); visit(filename); }
      else {
        bytes += stat.size;
        if (bytes > LIMITS.totalBytes) fail('input-size-invalid');
        entries.push([relative, stat.mode, hashFile(filename, LIMITS.assetBytes, true)]);
      }
    }
  };
  visit(root);
  if (!count) fail('build-input-missing');
  return sha256(Buffer.from(canonicalJson(entries)));
};

export const runSupplemental = (options: SupplementalOptionsType): void => {
  const assemble = options.operation === 'assemble';
  if (!assemble && options.operation !== 'build-platform') fail('operation-invalid');
  if (assemble !== Boolean(options.supplementalBuildRoot)) fail('phase-input-mismatch');
  const root = path.resolve(text(options.sourceRoot, 'path-invalid'));
  if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) fail('root-invalid');
  const authorityPath = safePath(root, relativePath(options.authorityPath));
  const snapshotPath = safePath(root, relativePath(options.snapshotPath));
  const authority = readRecord(authorityPath);
  const config = validateSnapshot(readRecord(snapshotPath), authority);
  if (config.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED !== 'true') fail('supplemental-asset-not-selected');
  const ownerContract = text(config.CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT, 'authority-contract-binding-mismatch');
  if (config.CI_SUPPLEMENTAL_RELEASE_ASSET_CONTRACT !== 'ci.release-asset-publication-contract#supplementalAsset'
    || !ownerContract.trim() || ownerContract === '__unset__') fail('authority-contract-binding-mismatch');
  const sourceSha = hex(authority.source_sha, 40);
  text(authority.version, 'version-invalid');
  if (checkoutSha(root) !== sourceSha) fail('source-identity-mismatch');
  const adapterRelative = relativePath(text(config.CI_SUPPLEMENTAL_RELEASE_ASSET_ADAPTER, 'owner-adapter-missing'));
  const adapter = safePath(root, adapterRelative);
  fs.accessSync(adapter, fs.constants.X_OK);
  let committedAdapter: Buffer;
  try { committedAdapter = execFileSync('git', ['-C', root, 'show', `${sourceSha}:${adapterRelative}`], { maxBuffer: LIMITS.jsonBytes, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return fail('owner-adapter-source-mismatch'); }
  if (sha256(committedAdapter) !== hashFile(adapter, LIMITS.jsonBytes)) fail('owner-adapter-source-mismatch');
  const standard = safePath(root, relativePath(options.standardBuildRoot), true);
  const supplemental = options.supplementalBuildRoot ? safePath(root, relativePath(options.supplementalBuildRoot), true) : undefined;
  const protectedDirectories = [standard, supplemental, path.join(root, '.git')]
    .filter((directory): directory is string => directory !== undefined && fs.existsSync(directory)).map(fileIdentity);
  const outputParts = relativePath(options.outputDirectory).split('/');
  let output = root;
  for (const [index, component] of outputParts.entries()) {
    output = path.join(output, component);
    try {
      const stat = fs.lstatSync(output);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('path-invalid');
      if (index === outputParts.length - 1) fail('output-already-exists');
      if (protectedDirectories.includes(fileIdentity(output))) fail('path-overlap');
      output = fs.realpathSync(output);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  if ([standard, supplemental, authorityPath, snapshotPath, adapter, path.join(root, '.git')]
    .some((input) => input !== undefined && overlaps(fs.existsSync(input) ? fs.realpathSync(input) : input, output))) fail('path-overlap');
  if (supplemental && (ancestorIdentities(standard, root).includes(fileIdentity(supplemental))
    || ancestorIdentities(supplemental, root).includes(fileIdentity(standard)))) fail('path-overlap');
  const fingerprint = (): unknown => {
    if (fs.realpathSync(root) !== root) fail('root-invalid');
    return {
      source: checkoutSha(root), authority: hashFile(safePath(root, options.authorityPath), LIMITS.jsonBytes),
      snapshot: hashFile(safePath(root, options.snapshotPath), LIMITS.jsonBytes), adapter: hashFile(safePath(root, adapterRelative)),
      standard: treeDigest(safePath(root, options.standardBuildRoot, true)),
      supplemental: options.supplementalBuildRoot ? treeDigest(safePath(root, options.supplementalBuildRoot, true)) : undefined,
    };
  };
  const before = fingerprint();
  const args = [options.operation, options.authorityPath, options.snapshotPath, options.standardBuildRoot,
    ...(options.supplementalBuildRoot ? [options.supplementalBuildRoot] : []), options.outputDirectory];
  // Owner execution must not accidentally write into the calling Action's runner channels.
  const environment = { ...process.env };
  for (const name of ['GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STEP_SUMMARY']) delete environment[name];
  // Preserve v2 shebang/argv semantics through Bash, including native Windows Git Bash.
  try { execFileSync('bash', ['--noprofile', '--norc', '-c', 'exec "$@"', 'supplemental-owner', adapter.split(path.sep).join('/'), ...args], { cwd: root, env: environment, stdio: 'ignore' }); }
  catch { fail('owner-adapter-failed'); }
  equal(before, fingerprint(), 'build-input-mutated');
  const created = safePath(root, options.outputDirectory, true);
  if (!fs.readdirSync(created).length) fail('supplemental-asset-missing');
};
