import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeFailure, DiagnosticError, FailureContext } from '../diagnostics/failure.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, '../..');
const tableHeading = '## Action一覧';
const startMarker = '<!-- action-catalog:start -->';
const endMarker = '<!-- action-catalog:end -->';

const parseScalar = (content, key) => {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) throw new DiagnosticError(`action.yml is missing ${key}`, { diagnosticCode: 'action-catalog-metadata-missing', diagnostics: { field: key, expected: 'present', observed: 'missing' } });
  return match[1].trim().replace(/^['"]|['"]$/g, '');
};

const actionNameFromRow = (row) => row.match(/^\|\s*\[`([^`]+)`\]\(/)?.[1] ?? null;

const tableCell = (value) => value.replace(/\s+/g, ' ').trim().replaceAll('|', '\\|');

const readActions = async (root, diagnostic) => {
  const actionsRoot = path.join(root, 'actions');
  diagnostic.at('action-inventory', { input: 'actions' });
  const entries = await readdir(actionsRoot, { withFileTypes: true });
  const actions = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    diagnostic.at('action-metadata-read', { input: `actions/${entry.name}/action.yml` });
    const actionPath = path.join(actionsRoot, entry.name);
    const actionFile = await readFile(path.join(actionPath, 'action.yml'), 'utf8');
    diagnostic.confirmed();
    diagnostic.at('action-readme-read', { input: `actions/${entry.name}/README.md` });
    const actionReadme = await readFile(path.join(actionPath, 'README.md'), 'utf8');
    diagnostic.confirmed();
    diagnostic.at('action-metadata-validation', { input: `actions/${entry.name}/action.yml` });
    const name = parseScalar(actionFile, 'name');
    if (name !== entry.name) throw new DiagnosticError(`Action directory/name mismatch: ${entry.name} != ${name}`, { diagnosticCode: 'action-catalog-name-mismatch' });
    actions.push({
      directory: entry.name,
      name,
      description: parseScalar(actionFile, 'description'),
      readmeSummary: actionReadme.split(/\n\s*\n/).find((paragraph) => paragraph.trim() && !paragraph.trim().startsWith('#'))?.trim() ?? '',
    });
  }
  return actions;
};

const existingRows = (readme) => {
  const sectionStart = readme.indexOf(tableHeading);
  if (sectionStart < 0) throw new DiagnosticError(`README.md is missing: ${tableHeading}`, { diagnosticCode: 'action-catalog-section-missing' });
  const nextSection = readme.indexOf('\n## ', sectionStart + tableHeading.length);
  const section = readme.slice(sectionStart, nextSection < 0 ? readme.length : nextSection);
  return section.split('\n').filter((line) => actionNameFromRow(line));
};

const generatedRow = (action) => {
  const usage = action.readmeSummary || action.description;
  return `| [\`${action.name}\`](actions/${action.directory}/README.md) | ${tableCell(usage)} | ${tableCell(action.description)} |`;
};

export const updateActionTable = (readme, actions) => {
  const rows = existingRows(readme);
  const rowsByName = new Map(rows.map((row) => [actionNameFromRow(row), row]));
  const currentNames = new Set(actions.map((action) => action.name));
  const orderedExisting = rows
    .map((row) => actionNameFromRow(row))
    .filter((name) => currentNames.has(name));
  const appended = actions
    .map((action) => action.name)
    .filter((name) => !orderedExisting.includes(name));
  const orderedNames = [...orderedExisting, ...appended];
  const actionByName = new Map(actions.map((action) => [action.name, action]));
  const renderedRows = orderedNames.map((name) => rowsByName.get(name) ?? generatedRow(actionByName.get(name)));

  const sectionStart = readme.indexOf(tableHeading);
  const tableStart = readme.indexOf('\n| Action |', sectionStart) + 1;
  const firstRow = readme.indexOf('\n|', tableStart + 1);
  const nextSection = readme.indexOf('\n## ', sectionStart + tableHeading.length);
  const tableEnd = readme.indexOf('\n\n', firstRow < 0 ? tableStart : firstRow);
  const markerEnd = readme.indexOf(endMarker, firstRow < 0 ? tableStart : firstRow);
  const end = markerEnd >= 0 && (nextSection < 0 || markerEnd < nextSection)
    ? markerEnd + endMarker.length
    : tableEnd >= 0 && (nextSection < 0 || tableEnd < nextSection)
      ? tableEnd
      : nextSection;
  if (tableStart < 1 || end < 0) throw new DiagnosticError('README.md Action table could not be located', { diagnosticCode: 'action-catalog-table-missing' });

  const header = '| Action | 用途 | 概要 |\n| --- | --- | --- |';
  const markerStart = readme.lastIndexOf(startMarker, tableStart);
  const replacementStart = markerStart >= sectionStart && readme.slice(markerStart + startMarker.length, tableStart).trim() === ''
    ? markerStart
    : tableStart;
  const replacement = `${startMarker}\n\n${header}\n${renderedRows.join('\n')}\n\n${endMarker}`;
  return `${readme.slice(0, replacementStart)}${replacement}${readme.slice(end)}`;
};

const main = async (diagnostic) => {
  diagnostic.at('input-validation', { input: 'check-or-write-mode' });
  const args = new Set(process.argv.slice(2));
  const mode = args.has('--write') ? 'write' : args.has('--check') ? 'check' : null;
  if (!mode) throw new DiagnosticError('usage: node runtime/repository/update-action-index.mjs (--check|--write)', { diagnosticCode: 'action-catalog-arguments-invalid', diagnostics: { field: 'mode', expected: 'check-or-write', observed: 'missing' } });
  const root = defaultRoot;
  const readmePath = path.join(root, 'README.md');
  diagnostic.confirmed();
  diagnostic.at('catalog-input-read', { input: 'README.md' });
  const readme = await readFile(readmePath, 'utf8');
  diagnostic.confirmed();
  const actions = await readActions(root, diagnostic);
  diagnostic.confirmed();
  diagnostic.at('catalog-projection', { input: 'README.md', actionCount: actions.length });
  const updated = updateActionTable(readme, actions);
  diagnostic.confirmed();
  if (updated === readme) {
    console.log(`Action catalog is synchronized (${actions.length} actions).`);
    return;
  }
  if (mode === 'check') {
    throw new DiagnosticError('README.md Action catalog is stale; run --write before committing.', {
      diagnosticCode: 'action-catalog-stale', diagnostics: { field: 'README.md', expected: 'current-action-catalog', observed: 'stale' },
    });
  }
  diagnostic.at('catalog-write', { output: 'README.md' });
  diagnostic.writeState = 'catalog-write-may-be-partial';
  await writeFile(readmePath, updated, 'utf8');
  diagnostic.confirmed();
  diagnostic.writeState = 'catalog-updated';
  console.log(`Updated README.md Action catalog (${actions.length} actions).`);
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const diagnostic = new FailureContext('repository-action-distribution', 'action-catalog');
  try { await main(diagnostic); }
  catch (error) {
    process.exitCode = 1;
    const reason = diagnostic.report(error);
    completeFailure(reason, 1);
  }
}
