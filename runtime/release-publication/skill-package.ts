import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import policy from './skill-package-policy.json';
import { createSkillZip, type SkillZipEntryType } from './skill-zip';
import { assetName, canonicalJson, fail, hex, record, sha256 } from './io';
import { releaseSkillsPath as relativePath } from './selection';

export const SKILLS_OWNER_CONTRACT = 'ci.release-skills-package';
// Upper bound for one `git cat-file --batch` header (`<oid> blob <size>\n`) plus its input line.
const BATCH_OBJECT_OVERHEAD = 128;
type EntryType = SkillZipEntryType;
export type SkillPackageType = {
  assets: { name: string; bytes: Buffer }[];
  evidence: { name: string; bytes: Buffer }[];
};

// Source directories are Git paths; ZIP entries retain the portable archive path contract.
const sourceDirectory = (input: unknown): string => {
  if (input === '.') return input;
  if (typeof input !== 'string' || !input || input.length > 512 || /[\x00-\x1f\x7f\\]/.test(input)
    || /^[A-Za-z]:/.test(input) || input.split('/').some(part => !part || part === '.' || part === '..')) fail('skills-path-invalid');
  return input;
};

const excluded = (relative: string, required: string[]): boolean => {
  const parts = relative.split('/').map(part => part.toLowerCase());
  const name = parts[parts.length - 1];
  return parts.some(part => policy.excludedDirectories.includes(part))
    || policy.excludedNames.some(entry => entry.toLowerCase() === name)
    || policy.excludedSuffixes.some(suffix => name.endsWith(suffix))
    || (!required.includes(relative) && policy.compiledArtifactSuffixes.some(suffix => name.endsWith(suffix)));
};

// Only literal local dependencies can be resolved from a skill declaration.
// Variable and example paths remain the owner's explicit requiredFiles responsibility.
const localReferences = (markdown: string): string[] => {
  const fragments = [...markdown.matchAll(/`([^`\r\n]+)`/g)].map(match => match[1]);
  fragments.push(...[...markdown.matchAll(/\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g)].map(match => match[1]));
  fragments.push(...[...markdown.matchAll(/^\s{0,3}\[[^\]\r\n]+\]:\s*(\S+)/gm)].map(match => match[1]));
  const references = new Set<string>();
  for (const fragment of fragments) {
    for (const token of fragment.split(/\s+/)) {
      const value = token.replace(/^<([^<>]+)>$/, '$1').replace(/^\.\//, '').split('#')[0];
      if (!/^(references|scripts|assets)\//.test(value) || /[<>${}*]/.test(value)) continue;
      references.add(relativePath(value.replace(/\/$/, '')));
    }
  }
  return [...references];
};

const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!record(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) fail('skills-declaration-invalid');
  return value;
};

export const buildReleaseSkills = (sourceRoot: string, configPath: string, sourceSha: string, version: string, repository: string): SkillPackageType => {
  hex(sourceSha, 40);
  const rootPath = path.resolve(sourceRoot);
  if (fs.realpathSync(rootPath) !== rootPath || !fs.statSync(rootPath).isDirectory()) fail('skills-source-invalid');
  const git = (args: string[], maximum = Infinity): Buffer => {
    try { return execFileSync('git', ['-C', rootPath, ...args], { maxBuffer: maximum, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return fail('skills-source-invalid'); }
  };
  // One `git cat-file --batch` per skill replaces a process per file. This is only a cache: it never fails the build, and any
  // blob it does not return is read by the per-file path below, which keeps the original validation order and diagnostics.
  // The budget counts every object's header allowance, so the batch input and output stay within the remaining size budget.
  const readAhead = (candidates: { oid: string; size: number }[], budget: number): Map<string, Buffer> => {
    const wanted: { oid: string; size: number }[] = [];
    const seen = new Set<string>();
    let used = 0;
    for (const candidate of candidates) {
      if (seen.has(candidate.oid)) continue;
      if (!Number.isSafeInteger(candidate.size) || candidate.size < 0 || used + candidate.size + BATCH_OBJECT_OVERHEAD > budget) break;
      seen.add(candidate.oid);
      wanted.push(candidate);
      used += candidate.size + BATCH_OBJECT_OVERHEAD;
    }
    const blobs = new Map<string, Buffer>();
    if (!wanted.length) return blobs;
    let output: Buffer;
    try {
      output = execFileSync('git', ['-C', rootPath, 'cat-file', '--batch'], { input: `${wanted.map(entry => entry.oid).join('\n')}\n`,
        maxBuffer: used + 1024, timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return blobs; }
    let offset = 0;
    for (const { oid, size } of wanted) {
      const lineEnd = output.indexOf(0x0a, offset);
      const match = lineEnd < 0 ? null : /^([a-f0-9]{40}) blob (\d+)$/.exec(output.toString('utf8', offset, lineEnd));
      const start = lineEnd + 1;
      if (!match || match[1] !== oid || Number(match[2]) !== size || start + size >= output.length || output[start + size] !== 0x0a) return new Map();
      blobs.set(oid, output.subarray(start, start + size));
      offset = start + size + 1;
    }
    return blobs;
  };
  if (git(['rev-parse', 'HEAD']).toString('utf8').trim() !== sourceSha) fail('skills-source-mismatch');
  const declarationPath = relativePath(configPath);
  const declarationMode = git(['ls-tree', sourceSha, '--', declarationPath]).toString('utf8').split(' ')[0];
  if (!['100644', '100755'].includes(declarationMode)) fail('skills-declaration-invalid');
  const declarationBytes = git(['show', `${sourceSha}:${declarationPath}`]);
  let value: unknown;
  try { value = JSON.parse(declarationBytes.toString('utf8')); } catch { return fail('skills-declaration-invalid'); }
  const declaration = exact(value, ['schemaVersion', 'skills']);
  if (declaration.schemaVersion !== 'ci.release-skills.v1' || !Array.isArray(declaration.skills)
    || declaration.skills.length === 0) fail('skills-declaration-invalid');
  const entries: EntryType[] = [];
  const roots = new Set<string>();
  const skillNames = new Set<string>();
  const archiveNames = new Set<string>();
  const archiveDirectories = new Map<string, string>();
  let total = 0;
  for (const item of declaration.skills) {
    const skill = exact(item, ['path', 'include', 'requiredFiles']);
    const root = sourceDirectory(skill.path);
    if (roots.has(root)) fail('skills-root-invalid');
    roots.add(root);
    const paths = (input: unknown): string[] => {
      if (!Array.isArray(input) || !input.length) fail('skills-declaration-invalid');
      const result = input.map(relativePath);
      if (new Set(result.map(entry => entry.toLowerCase())).size !== result.length) fail('skills-declaration-invalid');
      return result;
    };
    const includes = paths(skill.include);
    const required = paths(skill.requiredFiles);
    const selected: EntryType[] = [];
    const prefix = root === '.' ? '' : `${root}/`;
    const sourcePaths = [...new Set(['SKILL.md', ...includes].map(relative => `:(literal)${prefix}${relative}`))];
    // `-l` makes git read every listed object, so a damaged blob would fail the listing before SKILL.md is validated.
    // Sizes are therefore an optimization: without them the original listing and per-file size reads apply.
    let tree: string;
    try {
      tree = execFileSync('git', ['-C', rootPath, 'ls-tree', '-rlz', sourceSha, '--', ...sourcePaths], { timeout: 30000, maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    } catch { tree = git(['ls-tree', '-rz', sourceSha, '--', ...sourcePaths]).toString('utf8'); }
    const records = tree.split('\0').filter(Boolean).map(line => {
      // The size column is `-` for non-blobs and `BAD` for a blob git cannot read; both leave the size unknown (see sizeOf).
      const match = /^(\d+) (\w+) ([a-f0-9]{40})(?: +(\d+|-|BAD))?\t(.+)$/.exec(line);
      if (!match || !match[5].startsWith(prefix)) fail('skills-source-invalid');
      return { mode: match[1], kind: match[2], oid: match[3], size: match[4] === undefined || !/^\d+$/.test(match[4]) ? Number.NaN : Number(match[4]), relative: match[5].slice(prefix.length) };
    });
    const entry = records.find(record => record.relative === 'SKILL.md');
    if (!entry) fail('skills-required-file-missing');
    if (entry.kind !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('skills-file-kind-invalid');
    const sizeOf = (record: { oid: string; size: number }): number => Number.isNaN(record.size)
      ? Number(git(['cat-file', '-s', record.oid], 1024).toString('utf8').trim()) : record.size;
    const skillSize = sizeOf(entry);
    if (!Number.isSafeInteger(skillSize) || skillSize < 0 || total + skillSize > policy.maximumTotalBytes) fail('skills-size-invalid');
    const blobs = readAhead([entry, ...records.filter(record => record.kind === 'blob' && ['100644', '100755'].includes(record.mode)
      && includes.some(include => record.relative === include || record.relative.startsWith(`${include}/`)) && !excluded(record.relative, required))]
      .filter(candidate => !Number.isNaN(candidate.size)), policy.maximumTotalBytes - total);
    const skillBytes = blobs.get(entry.oid) ?? git(['cat-file', 'blob', entry.oid], policy.maximumTotalBytes - total);
    const skillText = skillBytes.toString('utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillText);
    let header: unknown;
    try { header = frontmatter ? parse(frontmatter[1], { maxAliasCount: 0, uniqueKeys: true }) : undefined; }
    catch { return fail('skills-entry-invalid'); }
    if (!record(header) || typeof header.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(header.name)
      || typeof header.description !== 'string' || !header.description.trim()) fail('skills-entry-invalid');
    const name = relativePath(header.name);
    if (skillNames.has(name)) fail('skills-file-name-collision');
    skillNames.add(name);
    const matched = new Set<string>();
    for (const record of records) {
      const { relative } = record;
      const selection = includes.filter(include => relative === include || relative.startsWith(`${include}/`));
      if (!selection.length) continue;
      selection.forEach(include => matched.add(include));
      if (excluded(relative, required)) continue;
      relativePath(relative);
      if (record.kind !== 'blob' || !['100644', '100755'].includes(record.mode)) fail('skills-file-kind-invalid');
      const archiveName = `${name}/${relative}`;
      const parts = archiveName.split('/');
      for (let index = 1; index < parts.length; index++) {
        const directory = parts.slice(0, index).join('/');
        const key = directory.toLowerCase();
        if (archiveNames.has(key) || (archiveDirectories.has(key) && archiveDirectories.get(key) !== directory)) fail('skills-file-name-collision');
        archiveDirectories.set(key, directory);
      }
      if (archiveNames.has(archiveName.toLowerCase()) || archiveDirectories.has(archiveName.toLowerCase())) fail('skills-file-name-collision');
      archiveNames.add(archiveName.toLowerCase());
      const size = sizeOf(record);
      if (!Number.isSafeInteger(size) || size < 0
        || total + size > policy.maximumTotalBytes) fail('skills-size-invalid');
      const bytes = relative === 'SKILL.md' ? skillBytes : blobs.get(record.oid) ?? git(['cat-file', 'blob', record.oid], policy.maximumTotalBytes - total);
      total += bytes.length;
      if (total > policy.maximumTotalBytes) fail('skills-size-invalid');
      selected.push({ name: archiveName, bytes, mode: Number.parseInt(record.mode, 8) });
    }
    if (includes.some(include => !matched.has(include))) fail('skills-include-missing');
    if (['SKILL.md', ...required].some(file => !selected.some(entry => entry.name === `${name}/${file}`))) fail('skills-required-file-missing');
    for (const reference of localReferences(skillText)) {
      if (!selected.some(entry => entry.name === `${name}/${reference}` || entry.name.startsWith(`${name}/${reference}/`))) fail('skills-reference-missing');
    }
    for (const entry of selected) entries.push(entry);
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const filename = assetName(`${repository.split('/')[1]}-skills.zip`);
  const bytes = createSkillZip(entries);
  const digest = sha256(bytes);
  const encode = (entry: unknown): Buffer => Buffer.from(`${canonicalJson(entry)}\n`);
  const owner = encode({ owner_contract: SKILLS_OWNER_CONTRACT, source_sha: sourceSha, version,
    declaration_sha256: sha256(declarationBytes), asset_sha256: digest,
    files: entries.map(entry => ({ path: entry.name, size: entry.bytes.length, sha256: sha256(entry.bytes) })) });
  const provenance = encode({ owner_contract: SKILLS_OWNER_CONTRACT, source_sha: sourceSha, version, repository, declaration_sha256: sha256(declarationBytes) });
  const verification = encode({ status: 'success', owner_contract: SKILLS_OWNER_CONTRACT, source_sha: sourceSha,
    asset_sha256: digest, owner_evidence_sha256: sha256(owner), provenance_sha256: sha256(provenance) });
  return { assets: [{ name: filename, bytes }, { name: `${filename}.sha256`, bytes: Buffer.from(`${digest}  ${filename}\n`) }],
    evidence: [{ name: `${filename}.owner.json`, bytes: owner }, { name: `${filename}.provenance.json`, bytes: provenance }, { name: `${filename}.verification.json`, bytes: verification }] };
};
