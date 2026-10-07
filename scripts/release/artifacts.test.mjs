import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { c } from 'tar';
import { checkContent, inspect, inventory, safePath } from './artifacts.mjs';
import { packOne } from './simple.mjs';
import { checkArtifact } from './simple-check.mjs';
import { discover, run } from './workspace.mjs';

const manifest = { name: 'fixture', version: '1.0.0', exports: './index.js' };
const policy = { holds: {} };
const license = Buffer.from('fixture license');
const workspaces = [{ name: 'private-input', manifest: { private: true } }];

async function fixture(t, value = manifest, files = { 'index.js': 'export {};' }) {
  const directory = await mkdtemp(resolve(tmpdir(), 'release-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(resolve(directory, 'package'));
  for (const [name, bytes] of Object.entries({ 'package.json': JSON.stringify(value), LICENSE: license, ...files })) {
    await writeFile(resolve(directory, 'package', name), bytes);
  }
  const file = resolve(directory, 'fixture.tgz');
  await c({ cwd: directory, file, gzip: true }, ['package']);
  return { directory, file, bytes: await readFile(file) };
}

test('real tar identity/private flags and license must match expected source', async (t) => {
  const { file, bytes } = await fixture(t);
  await checkArtifact(file, manifest, workspaces, policy, license);
  for (const expected of [
    { ...manifest, name: 'other' },
    { ...manifest, version: '2.0.0' }
  ]) {
    await assert.rejects(inspect(bytes, expected), /identity/);
  }
  for (const privateFlag of [true, 'false']) {
    const other = await fixture(t, { ...manifest, private: privateFlag });
    await assert.rejects(inspect(other.bytes, manifest), /identity/);
  }
  await assert.rejects(checkArtifact(file, manifest, workspaces, policy, Buffer.from('wrong')), /LICENSE differs/);
  await assert.rejects(checkArtifact(file, manifest, workspaces, { holds: { fixture: {} } }, license), /Held artifact/);
  const missing = await fixture(t);
  await rm(resolve(missing.directory, 'package/LICENSE'));
  await c({ cwd: missing.directory, file: missing.file, gzip: true }, ['package']);
  await assert.rejects(checkArtifact(missing.file, manifest, workspaces, policy, license), /Missing root LICENSE/);
});

test('packed JS/TS/declarations/JSX keep private-import scanning on actual archive contents', async (t) => {
  for (const ext of ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts', 'd.ts', 'd.cts', 'd.mts', 'jsx', 'tsx']) {
    const value = { ...manifest, exports: `./index.${ext}` };
    const jsx = ext.endsWith('sx') ? 'const view = <section>{import("public-name")}</section>;' : '';
    const good = await fixture(t, value, { [`index.${ext}`]: `import "public-name"; ${jsx}` });
    await checkArtifact(good.file, value, workspaces, policy, license);
    const bad = await fixture(t, value, { [`index.${ext}`]: `import "private-input"; ${jsx}` });
    await assert.rejects(checkArtifact(bad.file, value, workspaces, policy, license), /Private import/);
    if (!jsx) continue;
    const dynamic = await fixture(t, value, { [`index.${ext}`]: jsx.replace('public-name', 'private-input') });
    await assert.rejects(checkArtifact(dynamic.file, value, workspaces, policy, license), /Private import/);
  }
});

test('entrypoints require actual regular files, safe conditions and matching wildcard substitutions', () => {
  const entries = ['package/dist/nested/a.js', 'package/dist/nested/a.d.ts'].map((path) => ({ path, type: 'File' }));
  checkContent({ manifest: { exports: { './*': { types: './dist/*.d.ts', import: './dist/*.js' } }, files: ['dist'] }, entries });
  for (const target of ['./missing.js', './dist/a.js#frag', './dist/a.js?query', './dist/%61.js', '../escape.js', './node_modules/a.js']) {
    assert.throws(() => checkContent({ manifest: { exports: target }, entries }));
  }
  for (const field of ['main', 'module', 'types', 'typings', 'bin']) {
    assert.throws(() => checkContent({ manifest: { [field]: './missing.js' }, entries }), /Missing packed target/);
  }
  assert.throws(() => checkContent({ manifest: { exports: './dist/nested/a.js' }, entries: [{ path: 'package/dist/nested/a.js', type: 'Directory' }] }));
  assert.throws(
    () =>
      checkContent({
        manifest: { exports: { './*': { types: './dist/*.d.ts', import: './dist/*.js' } } },
        entries: [...entries, { path: 'package/dist/b.js', type: 'File' }]
      }),
    /different subpaths/
  );
  assert.throws(() => checkContent({ manifest: { exports: false }, entries }), /exports shape/);
  assert.throws(() => checkContent({ manifest: { files: ['absent'] }, entries }), /Empty distribution/);
});

test('bin payload requires executable mode and shebang', () => {
  const entry = { path: 'package/bin.js', type: 'File', mode: 0o755, prefix: '#!' };
  checkContent({ manifest: { bin: { fixture: './bin.js' } }, entries: [entry] });
  for (const change of [{ mode: 0o644 }, { prefix: 'ex' }]) {
    assert.throws(() => checkContent({ manifest: { bin: './bin.js' }, entries: [{ ...entry, ...change }] }), /shebang and executable/);
  }
});

test('unsafe archive paths, duplicate entries and links fail closed', async (t) => {
  for (const path of ['/root', '../escape', 'package/../escape', 'package/a\\b', 'package/a:b', 'package/./a', 'package//a', 'package/a\0']) {
    assert.equal(safePath(path), false);
  }
  const { directory } = await fixture(t);
  const file = resolve(directory, 'bad.tgz');
  await c({ cwd: directory, file, gzip: true }, ['package/package.json', 'package/package.json']);
  await assert.rejects(inventory(await readFile(file)), /Duplicate/);
  await symlink('index.js', resolve(directory, 'package/link.js'));
  await c({ cwd: directory, file, gzip: true }, ['package']);
  await assert.rejects(inventory(await readFile(file)), /Unsupported archive entry/);
  await c({ cwd: directory, file, gzip: true, prefix: '../escape' }, ['package/package.json']);
  await assert.rejects(inventory(await readFile(file)), /Unsafe archive path/);
});

test('compressed/decompressed archive bounds and missing manifest are enforced', async (t) => {
  await assert.rejects(inventory(Buffer.alloc(32 * 1024 * 1024 + 1)), /Compressed archive too large/);
  await assert.rejects(inventory(gzipSync(Buffer.alloc(65 * 1024 * 1024))), /larger than|Cannot create/);
  const { directory, file } = await fixture(t);
  await c({ cwd: directory, file, gzip: true }, ['package/index.js']);
  await assert.rejects(inventory(await readFile(file)), /Missing regular/);
});

async function packingFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'release-pnpm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'fixture-root', version: '1.0.0', private: true }));
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - public\n  - private\nignoreScripts: false\nignorePnpmfile: false\n');
  await writeFile(resolve(root, '.pnpmfile.cjs'), 'throw Error("config hook executed");');
  await mkdir(resolve(root, 'public'));
  await mkdir(resolve(root, 'private'));
  await mkdir(resolve(root, 'output'));
  const pub = {
    ...manifest,
    name: 'public-fixture',
    devDependencies: { 'private-input': 'workspace:*' },
    scripts: { prepack: 'node -e "process.exit(99)"', postpack: 'node -e "process.exit(99)"' }
  };
  await writeFile(resolve(root, 'public/package.json'), JSON.stringify(pub));
  await writeFile(resolve(root, 'public/index.js'), 'export {};');
  await writeFile(resolve(root, 'private/package.json'), JSON.stringify({ name: 'private-input', version: '1.2.0', private: true }));
  return root;
}

test('actual guarded pnpm pack rewrites workspace dev inputs, suppresses hooks, cleans only owned LICENSE', async (t) => {
  const root = await packingFixture(t);
  const spawn = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (command, ...args) => {
    assert.equal(command, 'pnpm', 'Fixture must never execute npm/publication');
    return spawn(command, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  run('pnpm', ['install', '--offline'], root);
  const all = await discover(root);
  const pub = all.find((w) => w.name === 'public-fixture');
  const output = resolve(root, 'output');
  const packed = await packOne(pub, output, all, policy, license);
  assert.equal(packed.manifest.devDependencies['private-input'], '1.2.0');
  assert.ok(!(await readdir(pub.path)).includes('LICENSE'));
  await writeFile(resolve(pub.path, 'LICENSE'), license);
  await assert.rejects(packOne(pub, output, all, policy, license), /Duplicate packed filename/);
  assert.deepEqual(await readFile(resolve(pub.path, 'LICENSE')), license);
  await rm(resolve(output, packed.file));
  const bad = { ...pub.manifest, dependencies: { 'private-input': 'workspace:*' } };
  await writeFile(resolve(pub.path, 'package.json'), JSON.stringify(bad));
  await assert.rejects(packOne({ ...pub, manifest: bad }, output, all, policy, license), /Private runtime/);
  assert.deepEqual(await readdir(output), []);
});
