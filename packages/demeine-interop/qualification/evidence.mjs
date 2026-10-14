import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [...new Set([
  ...git('diff', '--name-only').trim().split('\n'),
  ...git('ls-files', '--others', '--exclude-standard').trim().split('\n'),
])].filter(Boolean).sort();
const inventory = [];
for (const file of files) {
  try { inventory.push({ file, sha256: hash(await readFile(resolve(root, file))) }); }
  catch (error) { if (error.code === 'ENOENT') inventory.push({ file, deleted: true }); else throw error; }
}
const snapshotHash = hash(JSON.stringify(inventory));
const result = { base: git('rev-parse', 'HEAD').trim(), snapshotHash, uncommitted: true, files: inventory };
await writeFile(resolve(root, '.cache/demeine-interop/source-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
