#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const canonicalRuntimeRoot = path.join(sourceRoot, 'runtime', 'preset');
const validatorPath = path.join(canonicalRuntimeRoot, 'validate-ci-preset.ts');

const diagnostic = (reason, message, outcome = 'cannot-start') => {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: '1',
    kind: 'ci-github-preflight-bootstrap',
    outcome,
    reason,
    message,
  })}\n`);
  return 2;
};

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const parseArgs = (argv) => {
  const options = { presets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--audit-mode') options.auditMode = value;
    else if (flag === '--repo-root') options.repoRoot = value;
    else if (flag === '--skill-collection-root') options.skillCollectionRoot = value;
    else if (flag === '--preset') options.presets.push(value);
    else if (flag === '--output') options.output = value;
    else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }
  if (!['read-only', 'remediation'].includes(options.auditMode)) {
    throw new Error('--audit-mode must be read-only or remediation');
  }
  if (!options.repoRoot) throw new Error('--repo-root is required');
  if (options.auditMode === 'read-only' && options.output) {
    throw new Error('--output is not allowed in read-only mode');
  }
  return options;
};

const realDirectory = (value, label) => {
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
};

const sameRegularFile = (left, right) => {
  for (const target of [left, right]) {
    if (!fs.lstatSync(target).isFile()) return false;
  }
  return fs.readFileSync(left).equals(fs.readFileSync(right));
};

const findEscapingSymlink = (root) => {
  const visited = new Set();
  const visit = (directory) => {
    const realDirectoryPath = fs.realpathSync(directory);
    if (visited.has(realDirectoryPath)) return undefined;
    visited.add(realDirectoryPath);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(entryPath);
        if (!isWithin(root, target)) return entryPath;
        if (fs.statSync(target).isDirectory()) {
          const escaping = visit(target);
          if (escaping) return escaping;
        }
      } else if (entry.isDirectory()) {
        const escaping = visit(entryPath);
        if (escaping) return escaping;
      }
    }
    return undefined;
  };
  return visit(root);
};

const run = () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    return diagnostic('invalid-input', error instanceof Error ? error.message : String(error));
  }

  let repoRoot;
  let skillCollectionRoot;
  let runtimeRoot;
  let toolStateRoot;
  let expectedToolStateRoot;
  try {
    repoRoot = realDirectory(options.repoRoot, 'repo root');
    if (options.skillCollectionRoot !== undefined) {
      skillCollectionRoot = realDirectory(options.skillCollectionRoot, 'skill collection root');
    }
    expectedToolStateRoot = path.join(repoRoot, '.a3-skills', 'ci-github');
    toolStateRoot = realDirectory(expectedToolStateRoot, 'project-local tool state root');
  } catch (error) {
    return diagnostic('runtime-unavailable', error instanceof Error ? error.message : String(error));
  }

  if (path.relative(expectedToolStateRoot, toolStateRoot) !== '') {
    return diagnostic(
      'tool-state-path-mismatch',
      'project-local .a3-skills/ci-github must resolve to its fixed physical path',
    );
  }

  try {
    runtimeRoot = realDirectory(path.join(toolStateRoot, 'runtime'), 'runtime root');
  } catch (error) {
    return diagnostic('runtime-unavailable', error instanceof Error ? error.message : String(error));
  }
  if (!isWithin(toolStateRoot, runtimeRoot)) {
    return diagnostic('runtime-outside-tool-state', 'runtime root must be inside the isolated tool state root');
  }

  try {
    for (const filename of ['package.json', 'package-lock.json']) {
      const canonical = path.join(canonicalRuntimeRoot, filename);
      const prepared = path.join(runtimeRoot, filename);
      if (!sameRegularFile(canonical, prepared)) {
        return diagnostic('runtime-lock-mismatch', `${filename} does not match the canonical runtime`);
      }
    }
  } catch (error) {
    return diagnostic(
      'runtime-lock-mismatch',
      error instanceof Error ? error.message : String(error),
    );
  }

  let nodeModulesRoot;
  try {
    nodeModulesRoot = realDirectory(path.join(runtimeRoot, 'node_modules'), 'node_modules');
  } catch (error) {
    return diagnostic(
      'runtime-dependency-tree-invalid',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!isWithin(toolStateRoot, nodeModulesRoot)) {
    return diagnostic(
      'runtime-outside-tool-state',
      'node_modules must resolve inside the isolated tool state root',
    );
  }

  let tsxPath;
  let yamlRoot;
  try {
    tsxPath = fs.realpathSync(path.join(nodeModulesRoot, '.bin', 'tsx'));
    yamlRoot = realDirectory(path.join(nodeModulesRoot, 'yaml'), 'yaml package');
    fs.accessSync(tsxPath, fs.constants.X_OK);
  } catch (error) {
    return diagnostic(
      'runtime-dependency-tree-invalid',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!isWithin(nodeModulesRoot, tsxPath) || !isWithin(nodeModulesRoot, yamlRoot)) {
    return diagnostic(
      'runtime-outside-tool-state',
      'validator dependencies must resolve inside the prepared node_modules',
    );
  }
  let escapingSymlink;
  try {
    escapingSymlink = findEscapingSymlink(nodeModulesRoot);
  } catch (error) {
    return diagnostic(
      'runtime-dependency-tree-invalid',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (escapingSymlink) {
    return diagnostic(
      'runtime-outside-tool-state',
      `dependency symlink resolves outside the prepared node_modules: ${escapingSymlink}`,
    );
  }

  let childEnv;
  let runStateRoot;
  try {
    const processTempRoot = realDirectory(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'OS temp root');
    runStateRoot = fs.mkdtempSync(path.join(processTempRoot, 'a3-ci-github-'));
    const childTempRoot = runStateRoot;
    const npmCacheRoot = path.join(runStateRoot, 'npm-cache');
    const xdgCacheRoot = path.join(runStateRoot, 'xdg-cache');
    for (const directory of [npmCacheRoot, xdgCacheRoot]) {
      fs.mkdirSync(directory);
      const resolved = realDirectory(directory, 'isolated child state');
      if (!isWithin(runStateRoot, resolved)) {
        throw new Error('child process state must resolve inside the process temp root');
      }
    }
    if (process.platform !== 'win32') {
      const socketLimit = process.platform === 'darwin' ? 103 : 107;
      const userId = typeof process.getuid === 'function' ? process.getuid() : process.pid;
      const longestSocketPath = path.join(childTempRoot, `tsx-${userId}`, '2147483647.pipe');
      if (Buffer.byteLength(longestSocketPath) > socketLimit) {
        throw new Error('process temp root is too long for the tsx IPC socket');
      }
    }
    childEnv = {
      ...process.env,
      TMPDIR: childTempRoot,
      TMP: childTempRoot,
      TEMP: childTempRoot,
      XDG_CACHE_HOME: xdgCacheRoot,
      TSX_DISABLE_CACHE: '1',
      npm_config_cache: npmCacheRoot,
      npm_config_update_notifier: 'false',
    };
  } catch (error) {
    if (runStateRoot) fs.rmSync(runStateRoot, { recursive: true, force: true });
    return diagnostic(
      'tool-state-invalid',
      error instanceof Error ? error.message : String(error),
    );
  }

  const executeValidator = () => {
    const npmResult = spawnSync(
      'npm',
      ['ls', '--prefix', runtimeRoot, '--all', '--json', '--no-audit', '--no-fund'],
      {
        encoding: 'utf8',
        env: childEnv,
      },
    );
    if (npmResult.error || npmResult.status !== 0) {
      const message = npmResult.error?.message || npmResult.stderr.trim()
        || 'npm dependency tree validation failed';
      return diagnostic(
        'runtime-dependency-tree-invalid',
        message,
      );
    }

    const validatorArgs = [
      validatorPath,
      '--repo-root', repoRoot,
    ];
    if (skillCollectionRoot !== undefined) validatorArgs.push('--skill-collection-root', skillCollectionRoot);
    for (const preset of options.presets) validatorArgs.push('--preset', preset);
    if (options.output) validatorArgs.push('--output', options.output);
    const result = spawnSync(tsxPath, validatorArgs, {
      encoding: 'utf8',
      env: { ...childEnv, CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: runtimeRoot },
    });
    if (result.error) return diagnostic('validator-cannot-start', result.error.message);
    if (result.status === null) {
      return diagnostic('validator-cannot-start', 'validator terminated without an exit status');
    }
    if (result.status === 2) {
      return diagnostic(
        'validator-cannot-complete',
        result.stderr.trim() || 'validator terminated without a report',
        'cannot-complete',
      );
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  let execution;
  let executionError;
  try {
    execution = executeValidator();
  } catch (error) {
    executionError = error;
  }
  let cleanupError;
  try {
    fs.rmSync(runStateRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    const cleanupStatus = diagnostic(
      'tool-state-cleanup-failed',
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      'cannot-complete',
    );
    if (!executionError && typeof execution !== 'number' && execution?.status === 0) {
      return cleanupStatus;
    }
  }
  if (executionError) throw executionError;
  if (typeof execution === 'number') return execution;
  if (execution.stdout) process.stdout.write(execution.stdout);
  if (execution.stderr) process.stderr.write(execution.stderr);
  return execution.status;
};

process.exitCode = run();
