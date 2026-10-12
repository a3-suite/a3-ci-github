import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { parse } from 'yaml';
import policy from './skill-package-policy.json';
import { assetName, canonicalJson, fail, hex, record, sha256 } from './io';
import { releaseSkillsPath as relativePath } from './selection';

export const SKILLS_OWNER_CONTRACT = 'ci.release-skills-package';
type EntryType = { name: string; bytes: Buffer; mode: number };
export type SkillPackageType = {
  assets: { name: string; bytes: Buffer }[];
  evidence: { name: string; bytes: Buffer }[];
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

// A bounded, deterministic STORE ZIP avoids OS tools and does not execute skill source.
const zip = (entries: EntryType[]): Buffer => {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(entry.bytes.length, 20);
    directory.writeUInt32LE(entry.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + entry.bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
};

export const buildReleaseSkills = (sourceRoot: string, configPath: string, sourceSha: string, version: string, repository: string): SkillPackageType => {
  hex(sourceSha, 40);
  const rootPath = path.resolve(sourceRoot);
  if (fs.realpathSync(rootPath) !== rootPath || !fs.statSync(rootPath).isDirectory()) fail('skills-source-invalid');
  const git = (args: string[], maximum = policy.maximumFileBytes): Buffer => {
    try { return execFileSync('git', ['-C', rootPath, ...args], { maxBuffer: maximum, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return fail('skills-source-invalid'); }
  };
  if (git(['rev-parse', 'HEAD']).toString('utf8').trim() !== sourceSha) fail('skills-source-mismatch');
  const declarationPath = relativePath(configPath);
  const declarationMode = git(['ls-tree', sourceSha, '--', declarationPath]).toString('utf8').split(' ')[0];
  if (!['100644', '100755'].includes(declarationMode)) fail('skills-declaration-invalid');
  const declarationBytes = git(['show', `${sourceSha}:${declarationPath}`], 1048576);
  let value: unknown;
  try { value = JSON.parse(declarationBytes.toString('utf8')); } catch { return fail('skills-declaration-invalid'); }
  const declaration = exact(value, ['schemaVersion', 'skills']);
  if (declaration.schemaVersion !== 'ci.release-skills.v1' || !Array.isArray(declaration.skills)
    || declaration.skills.length === 0 || declaration.skills.length > 64) fail('skills-declaration-invalid');
  const entries: EntryType[] = [];
  const roots = new Set<string>();
  const archiveNames = new Set<string>();
  const archiveDirectories = new Map<string, string>();
  let total = 0;
  for (const item of declaration.skills) {
    const skill = exact(item, ['path', 'include', 'requiredFiles']);
    const root = relativePath(skill.path);
    const name = root.split('/')[1];
    if (!/^skills\/[a-z][a-z0-9-]*$/.test(root) || name === 'sdd' || roots.has(name)) fail('skills-root-invalid');
    roots.add(name);
    const paths = (input: unknown): string[] => {
      if (!Array.isArray(input) || !input.length || input.length > policy.maximumFiles) fail('skills-declaration-invalid');
      const result = input.map(relativePath);
      if (new Set(result.map(entry => entry.toLowerCase())).size !== result.length) fail('skills-declaration-invalid');
      return result;
    };
    const includes = paths(skill.include);
    const required = paths(skill.requiredFiles);
    const selected: EntryType[] = [];
    const tree = git(['ls-tree', '-rz', sourceSha, '--', root], 1048576).toString('utf8');
    const matched = new Set<string>();
    for (const line of tree.split('\0').filter(Boolean)) {
      const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
      if (!match || !match[3].startsWith(`${root}/`)) fail('skills-source-invalid');
      const relative = match[3].slice(root.length + 1);
      const selection = includes.filter(include => relative === include || relative.startsWith(`${include}/`));
      if (!selection.length) continue;
      selection.forEach(include => matched.add(include));
      if (excluded(relative, required)) continue;
      relativePath(relative);
      if (!['100644', '100755'].includes(match[1])) fail('skills-file-kind-invalid');
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
      const size = Number(git(['cat-file', '-s', match[2]], 1024).toString('utf8').trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > policy.maximumFileBytes
        || total + size > policy.maximumTotalBytes) fail('skills-size-invalid');
      const bytes = git(['cat-file', 'blob', match[2]]);
      total += bytes.length;
      if (total > policy.maximumTotalBytes || entries.length + selected.length >= policy.maximumFiles) fail('skills-size-invalid');
      selected.push({ name: archiveName, bytes, mode: Number.parseInt(match[1], 8) });
    }
    if (includes.some(include => !matched.has(include))) fail('skills-include-missing');
    if (['SKILL.md', ...required].some(file => !selected.some(entry => entry.name === `${name}/${file}`))) fail('skills-required-file-missing');
    const skillBytes = selected.find(entry => entry.name === `${name}/SKILL.md`)!.bytes.toString('utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillBytes);
    let header: unknown;
    try { header = frontmatter ? parse(frontmatter[1], { maxAliasCount: 0, uniqueKeys: true }) : undefined; }
    catch { return fail('skills-entry-invalid'); }
    if (!record(header) || header.name !== name || typeof header.description !== 'string' || !header.description.trim()) fail('skills-entry-invalid');
    for (const reference of localReferences(skillBytes)) {
      if (!selected.some(entry => entry.name === `${name}/${reference}` || entry.name.startsWith(`${name}/${reference}/`))) fail('skills-reference-missing');
    }
    entries.push(...selected);
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const filename = assetName(`${repository.split('/')[1]}-skills.zip`);
  const bytes = zip(entries);
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
