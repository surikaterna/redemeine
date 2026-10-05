import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { c, Header } from 'tar';
import { sri } from '../workspace.mjs';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const rootManifest = JSON.parse(await readFile(resolve(repo, 'package.json'), 'utf8'));
export const policy = { schemaVersion: 1, registry: 'https://registry.npmjs.org/', internalScopes: ['@fixture'], holds: {}, knownBad: {} };
export const manifest = (name, extra = {}) => ({ name, version: '1.0.0', main: './dist/index.js', types: './dist/index.d.ts', files: ['dist'], ...extra });
export async function put(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

export async function workspace(packages, selectedPolicy = policy) {
  const root = await mkdtemp(resolve(tmpdir(), 'release-fixture-'));
  const clone = spawnSync('git', ['clone', '--shared', '--no-checkout', '--quiet', repo, root], { encoding: 'utf8' });
  if (clone.status !== 0) throw new Error(clone.stderr);
  await put(resolve(root, '.gitignore'), 'node_modules/\nevidence/\n');
  await put(resolve(root, 'package.json'), { name: 'fixture-root', version: '1.0.0', private: true, packageManager: rootManifest.packageManager });
  await put(resolve(root, 'pnpm-workspace.yaml'), "packages:\n  - 'nested/**'\n  - '!nested/excluded'\n  - 'website'\n");
  await put(resolve(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await put(resolve(root, 'scripts/release/policy.json'), selectedPolicy);
  await put(resolve(root, 'website/package.json'), { name: 'fixture-website', version: '1.0.0', private: true });
  await put(resolve(root, 'nested/excluded/package.json'), manifest('excluded'));
  for (const [index, pkg] of packages.entries()) {
    const dir = resolve(root, `nested/group/p${index}`);
    await put(resolve(dir, 'package.json'), pkg);
    await put(resolve(dir, 'dist/index.js'), 'export const value = 42;\n');
    await put(resolve(dir, 'dist/index.d.ts'), 'export declare const value: number;\n');
  }
  const registry = resolve(root, 'offline');
  await put(resolve(registry, 'index.json'), {});
  if (JSON.stringify(packages).includes('workspace:')) {
    const install = spawnSync('pnpm', ['install', '--ignore-scripts', '--offline', '--no-frozen-lockfile'], { cwd: root, encoding: 'utf8', timeout: 120000 });
    if (install.status !== 0) throw new Error(install.stdout + install.stderr);
  }
  const fixture = { root, registry, index: {}, output: resolve(root, 'evidence') };
  for (const pkg of packages) await addRegistry(fixture, pkg.name, []);
  return fixture;
}

export async function addRegistry(fixture, name, manifests, options = {}) {
  const metadata = { name, versions: {} };
  for (const pkg of manifests) {
    const dir = await mkdtemp(resolve(tmpdir(), 'registry-tar-'));
    await put(resolve(dir, 'package/package.json'), options.packed || pkg);
    await put(resolve(dir, 'package/dist/index.js'), 'export const value = 42;\n');
    await put(resolve(dir, 'package/dist/index.d.ts'), 'export declare const value: number;\n');
    const file = `${encodeURIComponent(name)}-${pkg.version}.tgz`;
    await c({ cwd: dir, gzip: true, file: resolve(fixture.registry, file) }, ['package']);
    const bytes = await readFile(resolve(fixture.registry, file));
    metadata.versions[pkg.version] = { ...pkg, dist: { tarball: file, integrity: options.integrity || sri(bytes) } };
    for (const key of options.omitMetadataKeys || []) delete metadata.versions[pkg.version][key];
  }
  const file = `${encodeURIComponent(name)}.json`;
  await put(resolve(fixture.registry, file), metadata);
  fixture.index[name] = file;
  await put(resolve(fixture.registry, 'index.json'), fixture.index);
}

export async function cli(fixture, extra = [], env = {}) {
  const guard = resolve(fixture.root, 'forbid-network.mjs');
  await put(guard, "globalThis.fetch = () => { throw new Error('Fixture network access forbidden'); };\n");
  const result = spawnSync(
    process.execPath,
    ['--import', guard, resolve(repo, 'scripts/release/check.mjs'), '--output', fixture.output, '--registry-fixture', fixture.registry, ...extra],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ...env }
    }
  );
  const report = JSON.parse(await readFile(resolve(fixture.output, 'manifest.json'), 'utf8'));
  return { ...result, report };
}

export function archive(entries) {
  const buffers = [];
  for (const { path, data = '', type = 'File', mode = 0o644, linkpath = '' } of entries) {
    const bytes = Buffer.from(data);
    const header = new Header({ path, size: bytes.length, type, mode, linkpath });
    header.encode();
    buffers.push(header.block, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
}

export function packageArchive(pkg, extra = []) {
  return archive([
    { path: 'package/package.json', data: JSON.stringify(pkg) },
    { path: 'package/dist/index.js', data: 'export {}' },
    { path: 'package/dist/index.d.ts', data: 'export {}' },
    ...extra
  ]);
}
