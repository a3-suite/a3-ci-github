import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import policy from './skill-package-policy.json';
import { createSkillZip, type SkillZipEntryType } from './skill-zip';
import { assetName, canonicalJson, fail, hex, record, sha256 } from './io';
import { releaseSkillsPath as relativePath } from './selection';

export const SKILLS_OWNER_CONTRACT = 'ci.release-skills-package';
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
    const tree = git(['ls-tree', '-rz', sourceSha, '--', ...sourcePaths]).toString('utf8');
    const records = tree.split('\0').filter(Boolean).map(line => {
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line);
      if (!match || !match[4].startsWith(prefix)) fail('skills-source-invalid');
      return { mode: match[1], kind: match[2], oid: match[3], relative: match[4].slice(prefix.length) };
    });
    const entry = records.find(record => record.relative === 'SKILL.md');
    if (!entry) fail('skills-required-file-missing');
    if (entry.kind !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('skills-file-kind-invalid');
    const skillSize = Number(git(['cat-file', '-s', entry.oid], 1024).toString('utf8').trim());
    if (!Number.isSafeInteger(skillSize) || skillSize < 0 || total + skillSize > policy.maximumTotalBytes) fail('skills-size-invalid');
    const skillBytes = git(['cat-file', 'blob', entry.oid], policy.maximumTotalBytes - total);
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
      const size = Number(git(['cat-file', '-s', record.oid], 1024).toString('utf8').trim());
      if (!Number.isSafeInteger(size) || size < 0
        || total + size > policy.maximumTotalBytes) fail('skills-size-invalid');
      const bytes = relative === 'SKILL.md' ? skillBytes : git(['cat-file', 'blob', record.oid], policy.maximumTotalBytes - total);
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
