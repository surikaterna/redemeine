import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const shell = spawnSync('sh', ['-c', 'if command -v bun; then exit 0; else exit 1; fi'], { encoding: 'utf8' });
assert.equal(shell.status, 1, 'Bun must be absent from shell resolution');
const child = spawnSync('bun', ['--version'], { encoding: 'utf8' });
assert.equal(child.error?.code, 'ENOENT', 'Bun must be absent from Node child-process resolution');
const versions = Object.fromEntries(
  ['pnpm', 'corepack', 'git', 'npm'].map((tool) => {
    const result = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${tool} must be available`);
    return [tool, result.stdout.trim()];
  })
);
console.log(JSON.stringify({ node: process.version, versions, bun: { shellExit: shell.status, childError: child.error.code } }, null, 2));
