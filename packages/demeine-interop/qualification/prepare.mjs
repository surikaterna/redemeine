import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, '.cache/demeine-interop');
const snapshot = resolve(output, 'candidate');
await rm(snapshot, { recursive: true, force: true });
await mkdir(snapshot, { recursive: true });
for (const name of ['packages', 'scripts', 'bin', '.changeset', 'LICENSE', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json', 'tsup.config.base.ts']) {
  await cp(resolve(root, name), resolve(snapshot, name), {
    recursive: true,
    filter: path => !['node_modules', 'dist', '.turbo'].includes(basename(path)),
  });
}
await symlink(resolve(root, 'node_modules'), resolve(snapshot, 'node_modules'), 'dir');
const packages = (await readdir(resolve(snapshot, 'packages')));
const before = {};
for (const name of packages) {
  const source = resolve(root, 'packages', name);
  await symlink(resolve(source, 'node_modules'), resolve(snapshot, 'packages', name, 'node_modules'), 'dir');
  const manifest = JSON.parse(await readFile(resolve(source, 'package.json')));
  before[manifest.name] = manifest.version;
}
// Changelog rendering needs committed GitHub metadata; disable rendering only in
// this disposable pre-audit snapshot. The release plan/version algorithm is unchanged.
const configPath = resolve(snapshot, '.changeset/config.json');
const config = JSON.parse(await readFile(configPath));
config.changelog = false;
await writeFile(configPath, JSON.stringify(config, null, 2));
execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'exec', 'changeset', 'version'], { cwd: snapshot, stdio: 'inherit' });
const delta = {};
for (const name of packages) {
  const manifest = JSON.parse(await readFile(resolve(snapshot, 'packages', name, 'package.json')));
  delta[manifest.name] = { source: before[manifest.name], candidate: manifest.version };
}
await writeFile(resolve(output, 'version-delta.json'), `${JSON.stringify(delta, null, 2)}\n`);
console.log(JSON.stringify({ snapshot, delta }, null, 2));
// Packing resolves installed workspace links. Give the snapshot its own links so
// workspace:* becomes the candidate version, never a source-tree version.
await rm(resolve(snapshot, 'node_modules'));
for (const name of packages) await rm(resolve(snapshot, 'packages', name, 'node_modules'));
execFileSync('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: snapshot, stdio: 'inherit' });
