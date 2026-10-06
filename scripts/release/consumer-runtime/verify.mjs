import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const cacache = require('/usr/local/lib/node_modules/npm/node_modules/cacache');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

async function installed(start, name) {
  let directory = start;
  while (directory.startsWith('/consumer')) {
    const path = resolve(directory, 'node_modules', name);
    try {
      return { path, manifest: JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (directory === '/consumer') break;
    directory = dirname(directory);
  }
  throw Object.assign(new Error(`Required/optional dependency missing: ${name}`), { code: 1 });
}

export async function verifyLock(job, result) {
  const bytes = await readFile('/consumer/package-lock.json');
  const lock = JSON.parse(bytes);
  assert.equal(lock.lockfileVersion, 3);
  result.lockSha256 = sha256(bytes);
  result.cache = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert(path.startsWith('node_modules/') && !path.includes('\\') && !path.split('/').some((part) => ['', '.', '..'].includes(part)) && !entry.link);
    assert.equal(new URL(entry.resolved).origin, new URL(job.endpoint).origin);
    assert(/^sha512-/.test(entry.integrity));
    const pkg = JSON.parse(await readFile(resolve('/consumer', path, 'package.json'), 'utf8'));
    assert.equal(pkg.version, entry.version);
    await verifyOwned(job, pkg, entry, path, result);
    await verifyDependencies(job, pkg, resolve('/consumer', path));
  }
  for (const root of job.roots) {
    const artifact = job.artifacts.find((a) => `${a.manifest.name}@${a.manifest.version}` === root);
    const actual = await installed('/consumer', artifact.manifest.name);
    assert.equal(actual.manifest.version, artifact.manifest.version);
  }
  result.realpaths = await checkRealpaths('/consumer/node_modules');
  await writeFile('/job/package-lock.json', bytes);
}

async function verifyOwned(job, pkg, entry, path, result) {
  const owned = job.owned.names.includes(pkg.name) || job.owned.scopes.some((scope) => pkg.name.startsWith(`${scope}/`));
  if (!owned) return;
  const artifact = job.artifacts.find((a) => a.manifest.name === pkg.name && a.manifest.version === pkg.version);
  assert(artifact, 'Installed uninventoried owned identity');
  assert.equal(entry.integrity, artifact.integrity);
  const cached = await cacache.get.byDigest('/home/consumer/cache/_cacache', artifact.integrity);
  assert.equal(sha256(cached), artifact.sha256);
  assert.equal(sri(cached), artifact.integrity);
  result.cache.push({ path, name: pkg.name, version: pkg.version, integrity: artifact.integrity, sha256: sha256(cached) });
}

async function verifyDependencies(job, pkg, directory) {
  const key = `${pkg.name}@${pkg.version}`;
  for (const edge of job.graph[key] || []) {
    const found = await installed(directory, edge.name);
    assert.equal(`${found.manifest.name}@${found.manifest.version}`, edge.target, 'Realized owned graph differs from A');
  }
  const required = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  for (const name of Object.keys(required)) {
    if (pkg.peerDependenciesMeta?.[name]?.optional === true && !pkg.dependencies?.[name] && !pkg.optionalDependencies?.[name]) continue;
    await installed(directory, name);
  }
}

async function checkRealpaths(root) {
  const pending = [root];
  let count = 0;
  while (pending.length) {
    const path = pending.pop();
    assert(++count < 100000, 'Installed tree exceeds bound');
    const actual = await realpath(path);
    assert(actual === '/consumer/node_modules' || actual.startsWith('/consumer/node_modules/'), 'Installed path escapes consumer node_modules');
    const stat = await lstat(path);
    if (stat.isDirectory()) for (const child of await readdir(path)) pending.push(resolve(path, child));
  }
  return { boundary: '/consumer/node_modules', entries: count };
}
