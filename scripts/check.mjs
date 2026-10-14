import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const directory of ['src', 'public', 'test', 'scripts']) {
  for (const filename of readdirSync(path.join(root, directory)).filter(name => /\.(?:js|mjs)$/.test(name))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, filename)], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
JSON.parse(readFileSync(path.join(root, '.vscode', 'launch.json'), 'utf8'));
console.log('JavaScript syntax and project configuration checks passed.');
