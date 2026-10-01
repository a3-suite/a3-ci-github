import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Reuse the Actions' pinned compiler to interpret module syntax and resolution; no regex dependency graph.
export const inspectRuntimeGraph = (root, graph) => {
  const findings = [];
  const relative = (file) => path.relative(root, file).split(path.sep).join('/');
  for (const [source, targets] of graph) {
    if (!relative(source).startsWith('runtime/')) continue;
    for (const target of targets) {
      if (relative(target).startsWith('actions/')) findings.push(`runtime-to-action: ${relative(source)} -> ${relative(target)}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const walk = (file) => {
    if (visiting.has(file)) { findings.push(`runtime-cycle: ${relative(file)}`); return; }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const target of graph.get(file) ?? []) if (relative(target).startsWith('runtime/')) walk(target);
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of graph.keys()) if (relative(file).startsWith('runtime/')) walk(file);
  return findings;
};

export const collectRuntimeGraph = (root, packages, compiler) => {
  const require = createRequire(path.join(packages[0].path, 'package.json'));
  const ts = compiler ?? require('typescript');
  const graph = new Map();
  const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true };
  const cache = ts.createModuleResolutionCache(root, (file) => file, options);
  const walk = (filename) => {
    if (graph.has(filename)) return;
    const targets = [];
    graph.set(filename, targets);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const specifiers = [];
    const visit = (node) => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typesOnly = clause?.isTypeOnly || (!clause?.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((item) => item.isTypeOnly));
        if (!typesOnly && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
        specifiers.push(node.moduleReference.expression.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const named = node.exportClause;
        const typesOnly = node.isTypeOnly || (named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every((item) => item.isTypeOnly));
        if (!typesOnly) specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
        specifiers.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of specifiers) {
      let resolved = ts.resolveModuleName(specifier, filename, options, ts.sys, cache).resolvedModule?.resolvedFileName;
      if (!resolved) {
        if (specifier.startsWith('.')) throw new Error(`unresolved local import: ${filename}: ${specifier}`);
        continue;
      }
      if (resolved.endsWith('.d.mts') && fs.existsSync(resolved.replace(/\.d\.mts$/, '.mjs'))) resolved = resolved.replace(/\.d\.mts$/, '.mjs');
      const relative = path.relative(root, resolved).split(path.sep).join('/');
      if (relative.startsWith('../') || relative.includes('/node_modules/') || !/\.(?:[cm]?js|[cm]?ts)$/.test(resolved) || /\.d\.[cm]?ts$/.test(resolved)) continue;
      targets.push(resolved);
      walk(resolved);
    }
  };
  for (const entry of packages) walk(path.join(entry.path, 'src/index.ts'));
  return graph;
};
export const assertRuntimeBoundaries = (root, packages) => {
  if (packages.length === 0) throw new Error('runtime boundary inspection requires bundled Actions');
  const findings = inspectRuntimeGraph(root, collectRuntimeGraph(root, packages));
  if (findings.length) throw new Error(findings.join('\n'));
};
