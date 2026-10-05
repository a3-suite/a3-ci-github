import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { threadId } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { hookRequire } = require('istanbul-lib-hook');
const config = JSON.parse(readFileSync(process.env.A3_CI_COVERAGE_CONFIG, 'utf8'));
const errors = [];
const compiled = new Map();
const transform = (filename, format) => {
  const key = `${filename}/${format}`;
  if (compiled.has(key)) return compiled.get(key);
  try {
    let source = config.scripts[filename];
    if (/\.[cm]?ts$/.test(filename) || format === 'cjs' && !filename.endsWith('.cjs')) {
      // Compiler workers inherit NODE_OPTIONS; loading another esbuild copy there
      // would register a second handler on the compiler's own message port.
      source = require('esbuild').transformSync(source, { loader: filename.endsWith('ts') ? 'ts' : 'js', format, target: 'node24',
        sourcefile: filename, keepNames: true, sourcemap: 'inline',
        define: format === 'cjs' ? { 'import.meta.url': JSON.stringify(pathToFileURL(filename).href) } : {} }).code;
    }
    compiled.set(key, source);
    return source;
  } catch (error) {
    // The standard require hook falls back to original code on exceptions.
    // Persist the failure so a successful test cannot produce a false coverage result.
    errors.push({ filename, message: String(error) });
    throw error;
  }
};
hookRequire((filename) => Object.hasOwn(config.scripts, filename),
  (_code, { filename }) => transform(filename, 'cjs'),
  { extensions: ['.js', '.cjs', '.mjs', ...(config.typescript ? ['.ts', '.cts', '.mts'] : [])] });
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith('file:') || loaded.format?.includes('commonjs')) return loaded;
    const filename = fileURLToPath(url);
    if (!Object.hasOwn(config.scripts, filename)) return loaded;
    return { ...loaded, format: 'module', source: transform(filename, 'esm') };
  },
});
process.on('exit', () => {
  const coverage = Object.fromEntries(Object.entries(globalThis.__coverage__ ?? {})
    .filter(([filename]) => Object.hasOwn(config.scripts, filename)));
  if (Object.keys(coverage).length === 0 && errors.length === 0) return;
  const destination = path.join(config.rawDirectory, `${process.pid}-${threadId}.json`);
  // An interrupted writer must remain distinguishable from a complete snapshot.
  writeFileSync(`${destination}.pending`,
    JSON.stringify({ nodeVersion: process.version, coverage, errors }));
  renameSync(`${destination}.pending`, destination);
});
