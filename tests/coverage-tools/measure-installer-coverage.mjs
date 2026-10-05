import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const outputRoot = path.join(root, 'tests/tmp/coverage/installer');
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, 'run-'));
const config = path.join(root, 'runtime/installer/tests/coverage.ini');
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', COVERAGE_RCFILE: config, COVERAGE_FILE: path.join(output, '.coverage') };
const commands = [
  ['run', '-m', 'unittest', 'discover', '-s', 'runtime/installer/tests', '-p', 'test_*.py'],
  ['combine', output],
  ['json', '-o', path.join(output, 'coverage.json')],
  ['report'],
];
for (const command of commands) {
  const result = spawnSync('uv', ['run', '--no-project', '--with', 'coverage==7.16.2', 'coverage', ...command], { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Python source coverage: ${path.join(output, 'coverage.json')}`);
