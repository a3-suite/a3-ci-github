import { execFileSync } from 'node:child_process';

export const normalizePath = (value: string): string => value.replace(/\\/g, '/').trim();

export const isCommitSha = (value: string): boolean => /^[0-9a-f]{40}$/i.test(value);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const patternToRegex = (pattern: string): RegExp => {
  const escaped = escapeRegex(normalizePath(pattern));
  const wildcard = escaped.replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*');
  return new RegExp(`^${wildcard}$`);
};

export const createDocsOnlyMatcher = (patterns: string[]): ((value: string) => boolean) => {
  const regexes = patterns.filter(Boolean).flatMap((pattern) => {
    const normalized = normalizePath(pattern);
    const result = [patternToRegex(normalized)];
    if (normalized.startsWith('**/')) result.push(patternToRegex(normalized.slice(3)));
    return result;
  });
  return (value: string): boolean => regexes.some((regex) => regex.test(normalizePath(value)));
};

export const parseChangedFiles = (value: string): string[] => value.split('\n').map((line) => line.trim()).filter(Boolean);

export const classifyPaths = (files: string[], matcher: (value: string) => boolean): { docsFiles: string[]; otherFiles: string[] } => {
  const docsFiles: string[] = [];
  const otherFiles: string[] = [];
  for (const file of files) (matcher(file) ? docsFiles : otherFiles).push(file);
  return { docsFiles, otherFiles };
};

export const determineBaseSha = (base: string, event: string, prBase: string, before: string): string => {
  if (base && !['null', 'undefined'].includes(base)) return base;
  if (event === 'pull_request' && prBase && prBase !== 'null') return prBase;
  if (before && before !== 'null' && !/^0+$/.test(before)) return before;
  return '';
};

export type ChangeScope = { runCi: boolean; runDocs: boolean; files: string[]; docsFiles: string[]; otherFiles: string[]; status: 'success' | 'unresolved' };

export const detectChangeScope = (baseSha: string, headSha: string, matcher: (value: string) => boolean, runDiff: (base: string, head: string) => string): ChangeScope => {
  if (!baseSha || !headSha) return { runCi: true, runDocs: true, files: [], docsFiles: [], otherFiles: [], status: 'unresolved' };
  try {
    const files = parseChangedFiles(runDiff(baseSha, headSha));
    const { docsFiles, otherFiles } = classifyPaths(files, matcher);
    return { runCi: otherFiles.length > 0, runDocs: docsFiles.length > 0, files, docsFiles, otherFiles, status: 'success' };
  } catch {
    return { runCi: true, runDocs: true, files: [], docsFiles: [], otherFiles: [], status: 'unresolved' };
  }
};

export const runGitDiff = (base: string, head: string): string => {
  if (!isCommitSha(base) || !isCommitSha(head)) throw new Error('change-scope-sha-invalid');
  return execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
};
