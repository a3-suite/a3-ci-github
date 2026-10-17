import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, '../..');
const action = path.join(repository, 'actions/ci-release-supplemental-asset');
const ncc = path.join(action, 'node_modules/@vercel/ncc/dist/ncc/cli.js');
const compilerArguments = process.argv.slice(2);
if (compilerArguments.length > 1 || compilerArguments.length === 1 && compilerArguments[0] !== '--transpile-only') {
  throw new Error('installer-build-arguments-invalid: Expected no arguments or --transpile-only');
}
for (const [input, output] of [[path.join(action, 'src/index.ts'), path.join(action, 'dist')], [path.join(root, 'cli.ts'), path.join(root, 'dist')]]) {
  execFileSync(process.execPath, [ncc, 'build', input, '--minify', '-o', output, ...compilerArguments], { cwd: action, stdio: 'inherit' });
}
// The CLI runs next to runtime/installer/src, so only the Action bundle carries its own payload copy.
for (const relative of ['src/diagnostic-reasons.json', 'src/assembly.py', 'src/build-installer.py', 'src/build-shared-wrapper.py', 'src/builder_common.py', 'src/platform/install.sh', 'src/platform/install.ps1', 'src/wrapper/install.sh']) {
  const destination = path.join(action, 'dist/installer', relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, relative), destination);
}
