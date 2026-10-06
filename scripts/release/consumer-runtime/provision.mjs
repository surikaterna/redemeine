import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const tools = JSON.parse(await readFile('/opt/consumer-tools.json', 'utf8'));
assert(tools.nodes.some((entry) => entry.version === process.versions.node));
await mkdir('/tmp/bootstrap', { recursive: true });
await writeFile('/tmp/bootstrap/user.npmrc', '');
await writeFile('/tmp/bootstrap/global.npmrc', '');
const response = await fetch(`https://registry.npmjs.org/npm/-/npm-${tools.npm.version}.tgz`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
assert(response.ok);
const bytes = Buffer.from(await response.arrayBuffer());
assert(bytes.length < 32 * 1024 * 1024);
assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, tools.npm.integrity);
await writeFile('/tmp/npm.tgz', bytes);
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp/bootstrap',
  npm_config_userconfig: '/tmp/bootstrap/user.npmrc',
  npm_config_globalconfig: '/tmp/bootstrap/global.npmrc',
  npm_config_cache: '/tmp/bootstrap/cache',
  npm_config_registry: 'https://registry.npmjs.org/'
};
function npm(args) {
  const result = spawnSync('npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund'], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
}
npm(['install', '--global', '/tmp/npm.tgz']);
assert.equal(spawnSync('npm', ['--version'], { env, encoding: 'utf8' }).stdout.trim(), tools.npm.version);
npm(['install', '--prefix', '/opt/consumer-tools', '--save-exact', `typescript@${tools.typescript}`, `@types/node@${tools.nodeTypes}`]);
console.log(
  JSON.stringify({
    node: process.versions.node,
    npm: tools.npm.version,
    npmIntegrity: tools.npm.integrity,
    typescript: tools.typescript,
    nodeTypes: tools.nodeTypes
  })
);
