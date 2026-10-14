/** biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Uncached release host commands. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import semver from 'semver';

export const registry = 'https://registry.npmjs.org/';
export const pins = { node: '24.20.0', pnpm: '11.9.0', npm: '11.21.0' };
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
export const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function execute(command, args, cwd, spawn = spawnSync) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^p?npm_config_/i.test(key) && !/^npm_lifecycle_/i.test(key)));
  if (command === 'pnpm') {
    Object.assign(env, { pnpm_config_ignore_pnpmfile: 'true', pnpm_config_ignore_scripts: 'true', npm_config_ignore_scripts: 'true' });
    args = ['--config.ignore-pnpmfile=true', '--config.ignore-scripts=true', '--config.verify-deps-before-run=false', ...args];
  }
  return spawn(command, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
}

export function run(command, args, cwd) {
  const result = execute(command, args, cwd);
  assert.ok(!result.error && result.status === 0, `${command} failed (${result.status}): ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export function metadata(name, range, exec = execute) {
  const result = exec('npm', ['view', `${name}@${range}`, '--json', '--registry', registry, '--fetch-retries=0', '--fetch-timeout=30000']);
  assert.ok(!result.error, `Metadata request failed: ${name}`);
  const value = JSON.parse(result.stdout);
  if (result.status !== 0 && value?.error?.code === 'E404') return null;
  assert.equal(result.status, 0, `Metadata request failed: ${name}`);
  assert.ok(object(value) || (Array.isArray(value) && value.length), `Malformed metadata: ${name}`);
  return value;
}

export async function prerequisites(root) {
  assert.equal(process.versions.node, pins.node);
  const manifest = await json(resolve(root, 'package.json'));
  assert.match(manifest.packageManager, /^pnpm@11\.9\.0\+sha512\.[a-f0-9]{128}$/);
  for (const tool of ['pnpm', 'npm']) assert.equal(run(tool, ['--version'], root), pins[tool]);
  return json(resolve(root, 'scripts/release/policy.json'));
}

export async function discover(root) {
  const listed = JSON.parse(run('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], root));
  assert.ok(Array.isArray(listed) && listed.length, 'Invalid pnpm workspace inventory');
  const names = new Set();
  const paths = new Set();
  const packages = [];
  for (const item of listed) {
    const path = await realpath(item.path);
    const rel = relative(root, path);
    assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !paths.has(path), 'Invalid workspace path');
    const manifest = await json(resolve(path, 'package.json'));
    assert.ok(typeof manifest.name === 'string' && semver.valid(manifest.version) && !names.has(manifest.name), 'Invalid workspace identity');
    assert.ok(manifest.private === undefined || typeof manifest.private === 'boolean', 'Invalid private flag');
    names.add(manifest.name);
    paths.add(path);
    packages.push({ name: manifest.name, version: manifest.version, path, manifest });
  }
  assert.ok(paths.has(root), 'pnpm omitted root workspace');
  return packages;
}
