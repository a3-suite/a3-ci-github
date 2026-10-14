import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { describe, test, expect, onTestFinished, vi } from 'vitest';
import { executeAdapter, parseAdapterBundle } from '../src/adapter.js';
import { standardQualityBundle } from '../../../runtime/adapter/standard-quality-bundles.js';

const tools = vi.hoisted(() => ({
  invoke: undefined as ((command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string> | undefined) | undefined,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawnSync: (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) =>
    tools.invoke?.(command, args, options) ?? original.spawnSync(command, args, options) };
});

const temporaryRoot = path.resolve(__dirname, '../../../tmp');
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const interpreter = spawnSync(python, ['-c', 'import sys; print(sys.executable); print(sys.version.split()[0])'], { encoding: 'utf8' });
if (interpreter.status !== 0) throw new Error('Python is required for standard Python bundle regression');
const [pythonPath, pythonVersion] = interpreter.stdout.trim().split(/\r?\n/);

const fixture = (environmentPath = '.venv') => {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'python-standard-'));
  onTestFinished(() => { tools.invoke = undefined; fs.rmSync(directory, { recursive: true, force: true }); });
  const root = path.join(directory, 'project');
  const environment = path.resolve(root, environmentPath);
  fs.mkdirSync(root);
  const created = spawnSync(pythonPath, ['-m', 'venv', '--without-pip', environment], { encoding: 'utf8' });
  expect(created.status, created.stderr).toBe(0);
  const managedPython = path.join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const commands = path.join(directory, 'commands.jsonl');
  const scans = path.join(directory, 'scans.jsonl');
  const hook = `import json, os, sys\nfrom pathlib import Path\ndef record(event, args):\n    if event in ('os.scandir', 'os.listdir') and isinstance(args[0], (str, bytes, os.PathLike)):\n        entry = str(Path(os.fsdecode(args[0])).resolve())\n        with open(${JSON.stringify(scans)}, 'a') as output:\n            output.write(json.dumps(entry) + '\\n')\n        if os.environ.get('BLOCKED_DIRECTORY') and entry == str(Path(os.environ['BLOCKED_DIRECTORY']).resolve()):\n            raise PermissionError('fixture directory is unreadable')\n        if os.environ.get('USE_SYSTEM_PYTHON') != '1' and entry == str(Path(${JSON.stringify(environment)}).resolve()):\n            raise RuntimeError('managed environment was traversed')\nsys.addaudithook(record)\n`;
  tools.invoke = (command, args, options) => {
    if (options?.cwd !== root || !['python', 'uv'].includes(command)) return undefined;
    fs.appendFileSync(commands, JSON.stringify({ tool: command, args }) + '\n');
    const invokePython = (parameters: readonly string[]) => {
      const selected = options.env?.USE_SYSTEM_PYTHON === '1' ? pythonPath : managedPython;
      if (parameters[0] === '--version') return spawnSync(selected, parameters, { ...options, encoding: 'utf8' });
      const code = parameters[0] === '-c' ? parameters[1]
        : `import runpy; sys.argv = ${JSON.stringify(['compileall', ...parameters.slice(2)])}; runpy.run_module("compileall", run_name="__main__")`;
      return spawnSync(selected, ['-c', hook + code], { ...options, encoding: 'utf8' });
    };
    if (command === 'python') return invokePython(args);
    if (args[0] === 'run') {
      const parameters = args.slice(args[1] === '--no-sync' ? 2 : 1);
      if (parameters[0] === 'python') return invokePython(parameters.slice(1));
      if (parameters[0] === 'pytest') fs.writeFileSync(path.join(root, 'changed-by-test'), 'input/environment change');
    }
    const status = args[0] === 'sync' && options.env?.FAIL_PREPARATION === '1' ? 9 : 0;
    return { pid: 0, output: ['', '', ''], stdout: '', stderr: '', status, signal: null };
  };
  const run = (extraEnvironment: NodeJS.ProcessEnv = {}) => executeAdapter(
    parseAdapterBundle(standardQualityBundle('python-uv-quality').descriptor),
    { sourceRoot: root, toolchainVersion: pythonVersion, languageProfile: 'python', requireTrustedProjectScripts: false,
      environment: { ...process.env, ...extraEnvironment } },
  );
  const write = (relative: string, content = 'value = 1\n') => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  return { root, environment, commands, scans, run, write };
};

describe('ci-quality-adapter Python standard', () => {
  // contract_id: contract.ci-quality-adapter.outputs
  // integration_id: ci-quality-adapter-python-standard
  describe('managed environment scope', () => {
    test.each(['.venv', '.tools/env space+[x]', '../external-environment'])('preserves product layouts and prunes only the selected environment: %s', (environmentPath) => {
      // Arrange
      const project = fixture(environmentPath);
      for (const file of ['module.py', 'src/product/main.py', 'tests/test_main.py', 'packages/one/main.py', '.venv-product/code.py']) project.write(file);
      if (environmentPath !== '.venv') project.write('.venv/product.py');
      fs.writeFileSync(path.join(project.environment, 'dependency.py'), 'invalid python !\n');
      // Act
      const result = project.run();
      // Assert
      expect(result.status, JSON.stringify(result.results)).toBe('success');
      expect(result.results.map(({ id }) => id)).toStrictEqual(['toolchain-verify', 'dependency-restore', 'format', 'lint', 'test', 'security', 'structure']);
      expect(fs.readFileSync(project.scans, 'utf8')).not.toContain(JSON.stringify(fs.realpathSync(project.environment)));
      for (const relative of ['module.py', 'src/product/main.py', 'tests/test_main.py', 'packages/one/main.py', '.venv-product/code.py']) {
        expect(fs.existsSync(path.join(project.root, path.dirname(relative), '__pycache__'))).toBe(true);
      }
      if (environmentPath !== '.venv') expect(fs.existsSync(path.join(project.root, '.venv/__pycache__'))).toBe(true);
    });

    test('propagates traversal failures instead of silently omitting product directories', () => {
      // Arrange
      const project = fixture();
      project.write('unreadable/main.py');
      // Act
      const result = project.run({ BLOCKED_DIRECTORY: 'unreadable' });
      // Assert
      expect(result.status).toBe('failed');
      expect(result.results.at(-1)).toMatchObject({ id: 'structure', status: 'failed', exitCode: 1 });
      expect(result.results.at(-1)?.stderr).toContain('PermissionError');
    });

    test('retains the full syntax scan when a managed virtualenv cannot be confirmed', () => {
      // Arrange
      const project = fixture();
      project.write('.venv/dependency.py', 'invalid python !\n');
      // Act
      const result = project.run({ USE_SYSTEM_PYTHON: '1' });
      // Assert
      expect(result.status).toBe('failed');
      expect(result.results.at(-1)?.stdout).toContain('SyntaxError');
      expect(fs.readFileSync(project.scans, 'utf8')).toContain(JSON.stringify(fs.realpathSync(project.environment)));
    });

    test.each(['module.py', 'src/product/main.py', 'tests/test_main.py', 'packages/one/main.py', '.venv-product/code.py'])('retains syntax failure for product and test code: %s', (relative) => {
      // Arrange
      const project = fixture();
      project.write(relative, 'invalid python !\n');
      // Act
      const result = project.run();
      // Assert
      expect(result.status).toBe('failed');
      expect(result.results.at(-1)).toMatchObject({ id: 'structure', status: 'failed', exitCode: 1 });
      expect(result.results.at(-1)?.stdout).toContain('SyntaxError');
    });
  });

  describe('prepared environment reuse', () => {
    test('skips format and lint sync while keeping preparation and post-test security sync', () => {
      // Arrange
      const project = fixture('../external-environment');
      project.write('module.py');
      // Act
      const result = project.run();
      const calls = fs.readFileSync(project.commands, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      // Assert
      expect(result.status, JSON.stringify(result.results)).toBe('success');
      const uvCalls = calls.filter(({ tool }) => tool === 'uv');
      expect(uvCalls.filter(({ args }) => args[0] === 'sync' || args[0] === 'run' && args[1] !== '--no-sync')).toHaveLength(3);
      expect(uvCalls.filter(({ args }) => args.includes('ruff')).map(({ args }) => args.slice(0, 2))).toStrictEqual([['run', '--no-sync'], ['run', '--no-sync']]);
      expect(uvCalls.find(({ args }) => args.includes('pytest')).args.slice(0, 2)).toStrictEqual(['run', 'pytest']);
      expect(uvCalls.find(({ args }) => args.includes('pip-audit')).args.slice(0, 2)).toStrictEqual(['run', 'pip-audit']);
      expect(fs.existsSync(path.join(project.root, 'changed-by-test'))).toBe(true);
    });

    test('does not execute no-sync commands when initial preparation fails', () => {
      // Arrange
      const project = fixture();
      // Act
      const result = project.run({ FAIL_PREPARATION: '1' });
      // Assert
      expect(result.status).toBe('failed');
      expect(result.results.map(({ id }) => id)).toStrictEqual(['toolchain-verify', 'dependency-restore']);
      expect(result.results.at(-1)?.exitCode).toBe(9);
      expect(fs.readFileSync(project.commands, 'utf8').trim().split('\n')).toHaveLength(2);
    });
  });
});
