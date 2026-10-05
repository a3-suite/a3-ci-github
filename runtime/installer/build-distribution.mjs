import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, '../..');
const action = path.join(repository, 'actions/ci-release-supplemental-asset');
const ncc = path.join(action, 'node_modules/@vercel/ncc/dist/ncc/cli.js');
for (const [input, output] of [[path.join(action, 'src/index.ts'), path.join(action, 'dist')], [path.join(root, 'cli.ts'), path.join(root, 'dist')]]) {
  execFileSync(process.execPath, [ncc, 'build', input, '--minify', '-o', output], { cwd: action, stdio: 'inherit' });
  for (const relative of ['src/assembly.py', 'src/build-installer.py', 'src/build-shared-wrapper.py', 'src/builder_common.py', 'src/platform/install.sh', 'src/platform/install.ps1', 'src/wrapper/install.sh']) {
    const destination = path.join(output, 'installer', relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
}
