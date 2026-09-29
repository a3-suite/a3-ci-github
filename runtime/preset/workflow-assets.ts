import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { map, normalizeAsset, parseYaml } from './ci-preset-assets.ts';
import type { ValueMap } from './ci-preset-assets.ts';

const WORKFLOW_ASSET = /(?:\.ci-base\/)?(\.ci\/(?:scripts|provider|trusted|runtime)\/[A-Za-z0-9._/-]+)/g;

const LOCAL_ASSET = /(?:\$?\{?)(script_dir|runtime_dir)\}?\/([A-Za-z0-9._/-]+)/g;

const POWERSHELL_LOCAL_ASSET = /\$PSScriptRoot\s+['"]([A-Za-z0-9._/-]+)['"]/g;

const RELATIVE_IMPORT = /\b(?:from|import|require)\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g;

const PYTHON_IMPORT = /(?:^|\n)\s*(?:from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import|import\s+([A-Za-z_][A-Za-z0-9_.]*))/g;

const inside = (root: string, relativePath: string): string => {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path escapes repository root');
  return absolute;
};

const realPathIsInside = (root: string, absolutePath: string): boolean => {
  const realRoot = fs.realpathSync(root);
  const realPath = fs.realpathSync(absolutePath);
  const relative = path.relative(realRoot, realPath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const sha256 = (absolutePath: string): string => createHash('sha256')
  .update(fs.readFileSync(absolutePath))
  .digest('hex');

const stripComment = (line: string): string => {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? undefined : character;
      continue;
    }
    if (!quote && (character === '#' || (character === '/' && line[index + 1] === '/'))
      && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
};

const executableText = (text: string): string => text
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('/*') && !line.trimStart().startsWith('*'))
  .map(stripComment)
  .join('\n');

const directAssets = (text: string): Set<string> => {
  const result = new Set<string>();
  for (const match of executableText(text).matchAll(WORKFLOW_ASSET)) {
    const normalized = normalizeAsset(match[1]);
    if (normalized) result.add(normalized);
  }
  return result;
};

const indirectAssets = (
  root: string,
  initial: Set<string>,
  excludedReferences: ReadonlySet<string>,
): Set<string> => {
  const result = new Set(initial);
  const queue = [...initial];
  const scanned = new Set<string>();
  while (queue.length > 0) {
    const reference = queue.shift() as string;
    if (scanned.has(reference) || !/\.(?:sh|ps1|py|ts|js|mjs|cjs)$/.test(reference)) continue;
    scanned.add(reference);
    let absolute: string;
    try { absolute = inside(root, reference); } catch { continue; }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const text = executableText(fs.readFileSync(absolute, 'utf8'));
    const discovered = directAssets(text);
    for (const match of text.matchAll(LOCAL_ASSET)) {
      const base = match[1] === 'script_dir' ? path.posix.dirname(reference) : '.ci/runtime';
      const normalized = normalizeAsset(path.posix.join(base, match[2]));
      if (normalized) discovered.add(normalized);
    }
    for (const match of text.matchAll(POWERSHELL_LOCAL_ASSET)) {
      const normalized = normalizeAsset(path.posix.join(path.posix.dirname(reference), match[1]));
      if (normalized) discovered.add(normalized);
    }
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const normalized = normalizeAsset(path.posix.join(path.posix.dirname(reference), match[1]));
      if (normalized) discovered.add(normalized);
    }
    if (reference.endsWith('.py')) {
      for (const match of text.matchAll(PYTHON_IMPORT)) {
        const modulePath = (match[1] ?? match[2]).split('.').join('/');
        for (const suffix of ['.py', '/__init__.py']) {
          const normalized = normalizeAsset(
            path.posix.join(path.posix.dirname(reference), `${modulePath}${suffix}`),
          );
          if (!normalized) continue;
          try {
            const absolute = inside(root, normalized);
            if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) discovered.add(normalized);
          } catch {
            continue;
          }
        }
      }
    }
    for (const item of discovered) {
      if (excludedReferences.has(item) || result.has(item)) continue;
      result.add(item);
      queue.push(item);
    }
  }
  return result;
};

const staticallyDisabledStep = (step: ValueMap, workflowEnv: ValueMap): boolean => {
  const condition = step.if;
  if (typeof condition !== 'string') return false;
  const match = condition.match(
    /^\s*(?:\$\{\{\s*)?env\.([A-Z][A-Z0-9_]*)\s*(==|!=)\s*'([^']+)'(?:\s*\}\})?\s*$/,
  );
  if (!match) return false;
  const actual = workflowEnv[match[1]];
  if (typeof actual !== 'string') return false;
  return match[2] === '==' ? actual !== match[3] : actual === match[3];
};

const findWorkflowAssetReferences = (
  root: string,
  workflowText: string,
  excludedReferences: ReadonlySet<string> = new Set(),
): string[] => {
  const parsed = map(parseYaml(workflowText, 'workflow'));
  const workflowEnv = map(parsed.env);
  const runs: string[] = [];
  if (typeof parsed.run === 'string') runs.push(parsed.run);
  for (const job of Object.values(map(parsed.jobs)).map(map)) {
    for (const step of Array.isArray(job.steps) ? job.steps.map(map) : []) {
      if (!staticallyDisabledStep(step, workflowEnv) && typeof step.run === 'string') {
        runs.push(step.run);
      }
    }
  }
  const directReferences = directAssets(runs.join('\n'));
  for (const excluded of excludedReferences) directReferences.delete(excluded);
  return [...indirectAssets(root, directReferences, excludedReferences)].sort();
};

const filesUnder = (root: string, directory: string, suffixes: string[]): string[] => {
  const absoluteRoot = path.join(root, directory);
  if (!fs.existsSync(absoluteRoot)) return [];
  const result: string[] = [];
  const visit = (absolute: string): void => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const entryPath = path.join(absolute, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
        result.push(path.relative(root, entryPath).split(path.sep).join('/'));
      }
    }
  };
  visit(absoluteRoot);
  return result.sort();
};

const inventoryUnder = (root: string, directory: string): string[] => {
  const absoluteRoot = path.join(root, directory);
  if (!fs.existsSync(absoluteRoot)) return [];
  const result: string[] = [];
  const visit = (absolute: string): void => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const entryPath = path.join(absolute, entry.name);
      if (entry.isDirectory() && entry.name === 'node_modules') {
        result.push(path.relative(root, entryPath).split(path.sep).join('/'));
      } else if (entry.isDirectory()) visit(entryPath);
      else result.push(path.relative(root, entryPath).split(path.sep).join('/'));
    }
  };
  visit(absoluteRoot);
  return result.sort();
};

export { inside, realPathIsInside, sha256, findWorkflowAssetReferences, filesUnder, inventoryUnder };
