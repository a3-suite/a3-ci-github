import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, '../..');
const tableHeading = '## Action一覧';
const startMarker = '<!-- action-catalog:start -->';
const endMarker = '<!-- action-catalog:end -->';

const parseScalar = (content, key) => {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) throw new Error(`action.yml is missing ${key}`);
  return match[1].trim().replace(/^['"]|['"]$/g, '');
};

const actionNameFromRow = (row) => row.match(/^\|\s*\[`([^`]+)`\]\(/)?.[1] ?? null;

const tableCell = (value) => value.replace(/\s+/g, ' ').trim().replaceAll('|', '\\|');

const readActions = async (root) => {
  const actionsRoot = path.join(root, 'actions');
  const entries = await readdir(actionsRoot, { withFileTypes: true });
  const actions = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const actionPath = path.join(actionsRoot, entry.name);
    const actionFile = await readFile(path.join(actionPath, 'action.yml'), 'utf8');
    const actionReadme = await readFile(path.join(actionPath, 'README.md'), 'utf8');
    const name = parseScalar(actionFile, 'name');
    if (name !== entry.name) throw new Error(`Action directory/name mismatch: ${entry.name} != ${name}`);
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
  if (sectionStart < 0) throw new Error(`README.md is missing: ${tableHeading}`);
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
  if (tableStart < 1 || end < 0) throw new Error('README.md Action table could not be located');

  const header = '| Action | 用途 | 概要 |\n| --- | --- | --- |';
  const markerStart = readme.lastIndexOf(startMarker, tableStart);
  const replacementStart = markerStart >= sectionStart && readme.slice(markerStart + startMarker.length, tableStart).trim() === ''
    ? markerStart
    : tableStart;
  const replacement = `${startMarker}\n\n${header}\n${renderedRows.join('\n')}\n\n${endMarker}`;
  return `${readme.slice(0, replacementStart)}${replacement}${readme.slice(end)}`;
};

const main = async () => {
  const args = new Set(process.argv.slice(2));
  const mode = args.has('--write') ? 'write' : args.has('--check') ? 'check' : null;
  if (!mode) throw new Error('usage: node runtime/repository/update-action-index.mjs (--check|--write)');
  const root = defaultRoot;
  const readmePath = path.join(root, 'README.md');
  const [readme, actions] = await Promise.all([readFile(readmePath, 'utf8'), readActions(root)]);
  const updated = updateActionTable(readme, actions);
  if (updated === readme) {
    console.log(`Action catalog is synchronized (${actions.length} actions).`);
    return;
  }
  if (mode === 'check') {
    console.error('README.md Action catalog is stale; run --write before committing.');
    process.exitCode = 1;
    return;
  }
  await writeFile(readmePath, updated, 'utf8');
  console.log(`Updated README.md Action catalog (${actions.length} actions).`);
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
