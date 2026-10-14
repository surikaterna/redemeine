import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { c } from 'tar';
import { checkArtifact, checkImports, checkManifest, dependency, dependencyOrder, eligible, selectCandidates } from './simple-check.mjs';

// Keep generic hold enforcement covered independently of current package approvals.
const policy = { holds: { '@redemeine/cli': {} } };
const workspace = (name, version = '1.0.0', privateFlag = false) => ({ name, version, manifest: { name, version, private: privateFlag } });
const workspaces = [workspace('@redemeine/future'), workspace('@redemeine/cli'), workspace('@redemeine/private', '1.0.0', true)];
const artifact = (name, dependencies = {}) => ({ manifest: { name, version: '1.0.0', dependencies } });
const noRead = () => assert.fail('Selected candidates must not require registry reads');
const publicConfigs = [undefined, {}, { access: 'public' }];
const invalidConfigs = ['restricted', 'Public', 'latest', '', null, false, 1, {}, []].map((access) => ({ access }));

test('synthetic CLI hold still rejects selection while permitting interop and its closure', async () => {
  for (const version of ['0.1.0-pre.0', '0.1.0-pre.1']) {
    const interop = workspace('@redemeine/demeine-interop', version);
    const selected = selectCandidates([...workspaces, interop], policy, `@redemeine/demeine-interop@${version}`, 'pre', 'pre');
    assert.deepEqual(selected, [interop]);
    assert.throws(() => selectCandidates([...workspaces, interop], policy, `@redemeine/demeine-interop@${version} @redemeine/cli@1.0.0`, 'pre'));
  }
  const kernel = { manifest: { name: '@redemeine/kernel', version: '0.2.0-pre.2' } };
  const aggregate = { manifest: { name: '@redemeine/aggregate', version: '0.2.0-pre.2', dependencies: { '@redemeine/kernel': '0.2.0-pre.2' } } };
  const interop = { manifest: { name: '@redemeine/demeine-interop', version: '0.1.0-pre.1', dependencies: { '@redemeine/kernel': '0.2.0-pre.2' } } };
  const owned = [kernel, aggregate, interop].map(({ manifest }) => ({ ...manifest, manifest }));
  assert.deepEqual(await dependencyOrder([interop, aggregate, kernel], owned, noRead), [kernel, interop, aggregate]);
});

async function sourceWorkspace(directory) {
  const manifest = JSON.parse(await readFile(new URL(`../../packages/${directory}/package.json`, import.meta.url), 'utf8'));
  return { name: manifest.name, version: manifest.version, manifest };
}

test('actual policy permits exact approved CLI/interop source versions but never private packages', async () => {
  const actualPolicy = JSON.parse(await readFile(new URL('./policy.json', import.meta.url), 'utf8'));
  const [cli, interop, privatePackage] = await Promise.all(['cli', 'demeine-interop', 'saga-runtime'].map(sourceWorkspace));
  assert.deepEqual(actualPolicy, { holds: {} });
  assert.equal(privatePackage.manifest.private, true);
  const all = [cli, interop, privatePackage];
  const exact = [cli, interop].map(w => `${w.name}@${w.version}`).join(' ');
  assert.deepEqual(selectCandidates(all, actualPolicy, exact, 'pre', 'pre'), [cli, interop]);
  assert.deepEqual(selectCandidates(all, actualPolicy, `${cli.name}@${cli.version}`, 'pre', 'pre'), [cli]);
  assert.throws(() => selectCandidates(all, actualPolicy, `${cli.name}@99.0.0`, 'pre', 'pre'));
  assert.throws(() => selectCandidates(all, actualPolicy, `${privatePackage.name}@${privatePackage.version}`, 'pre', 'pre'));
  assert.deepEqual(cli.manifest.repository, { type: 'git', url: 'https://github.com/surikaterna/redemeine.git', directory: 'packages/cli' });
});

test('actual policy selects only five approved candidates and orders their real runtime edges', async () => {
  const actualPolicy = JSON.parse(await readFile(new URL('./policy.json', import.meta.url), 'utf8'));
  const directories = ['kernel', 'aggregate', 'demeine-interop', 'cli', 'mirage'];
  const versions = ['0.2.0-pre.2', '0.2.0-pre.2', '0.1.0-pre.1', '0.2.0-pre.1', '1.0.0-pre.2'];
  const sources = await Promise.all(directories.map(sourceWorkspace));
  const byName = new Map(sources.map((w, index) => [w.name, versions[index]]));
  const candidates = sources.map((w, index) => ({ ...w, version: versions[index], manifest: {
    ...w.manifest, version: versions[index], dependencies: Object.fromEntries(Object.entries(w.manifest.dependencies ?? {})
      .map(([name, range]) => [name, range === 'workspace:*' ? byName.get(name) : range]))
  } }));
  const omitted = await Promise.all(['projection', 'saga', 'saga-runtime', 'testing'].map(sourceWorkspace));
  const owned = [...candidates, ...omitted];
  const approval = candidates.map(w => `${w.name}@${w.version}`).join(' ');
  assert.deepEqual(selectCandidates(owned, actualPolicy, approval, 'pre', 'pre'), candidates);
  const ordered = await dependencyOrder([...candidates].reverse(), owned, noRead);
  const position = name => ordered.findIndex(w => w.name === `@redemeine/${name}`);
  for (const name of ['aggregate', 'demeine-interop', 'cli', 'mirage']) assert(position('kernel') < position(name));
  assert(position('aggregate') < position('mirage'));
  assert.deepEqual(candidates[3].manifest.dependencies, { '@redemeine/kernel': '0.2.0-pre.2', typescript: '^5.9.3', zod: '^4.3.6' });
});

test('approval selects exact source versions; no hardcoded public membership or registry absence selection', () => {
  assert.deepEqual(eligible(workspaces, policy), [workspaces[0]]);
  assert.deepEqual(selectCandidates(workspaces, policy, '@redemeine/future@1.0.0', 'pre'), [workspaces[0]]);
  const future = workspace('future-new-package');
  assert.deepEqual(selectCandidates([...workspaces, future], policy, 'future-new-package@1.0.0', 'pre'), [future]);
  assert.deepEqual(selectCandidates([...workspaces, future], policy, '@redemeine/future@1.0.0', 'pre'), [workspaces[0]]);
});

test('empty, duplicate, unknown, private, held and wrong-version approval fail before packing', () => {
  for (const approved of [
    '',
    ' ',
    '@redemeine/future@1.0.0 @redemeine/future@1.0.0',
    'unknown@1.0.0',
    '@redemeine/private@1.0.0',
    '@redemeine/cli@1.0.0',
    '@redemeine/future@0.9.0'
  ]) {
    assert.throws(() => selectCandidates(workspaces, policy, approved, 'pre'));
  }
});

test('latest requires stable source versions AND exited Changesets prerelease mode', () => {
  assert.throws(() => selectCandidates(workspaces, policy, '@redemeine/future@1.0.0', 'latest', 'pre'), /Exit Changesets/);
  const preview = [workspace('preview', '1.0.0-pre.0')];
  assert.throws(() => selectCandidates(preview, policy, 'preview@1.0.0-pre.0', 'latest', 'exit'), /Exit Changesets/);
  selectCandidates(workspaces, policy, '@redemeine/future@1.0.0', 'latest', 'exit');
  assert.throws(() => selectCandidates(workspaces, policy, '@redemeine/future@1.0.0', 'other'), /explicitly/);
});

test('source approval accepts absent/public access without rejecting pnpm manifest transformations', () => {
  for (const publishConfig of [...publicConfigs, { access: 'public', main: './dist/index.js' }]) {
    const candidate = workspace('@redemeine/future');
    candidate.manifest.publishConfig = publishConfig;
    candidate.manifest.dependencies = { local: 'workspace:*' };
    assert.deepEqual(selectCandidates([candidate], policy, '@redemeine/future@1.0.0', 'pre'), [candidate]);
  }
});

test('source approval rejects restricted/malformed access before packing can transform owner intent', () => {
  for (const publishConfig of [...invalidConfigs, null, false, 'public', []]) {
    const candidate = workspace('@redemeine/future');
    candidate.manifest.publishConfig = publishConfig;
    assert.throws(() => selectCandidates([candidate], policy, '@redemeine/future@1.0.0', 'pre'), /publishConfig/);
  }
});

test('actual packed manifest independently requires absent/public access despite public source intent', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'release-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(resolve(directory, 'package'));
  const license = Buffer.from('fixture license');
  await writeFile(resolve(directory, 'package/LICENSE'), license);
  const expected = { ...workspaces[0].manifest, publishConfig: { access: 'public' } };
  const file = resolve(directory, 'packed.tgz');
  for (const publishConfig of [...publicConfigs, ...invalidConfigs, null, false, 'public', []]) {
    const manifest = { ...expected, publishConfig };
    await writeFile(resolve(directory, 'package/package.json'), JSON.stringify(manifest));
    await c({ cwd: directory, file, gzip: true }, ['package']);
    const checked = checkArtifact(file, expected, workspaces, policy, license);
    if (publicConfigs.includes(publishConfig)) assert.deepEqual((await checked).manifest, JSON.parse(JSON.stringify(manifest)));
    else await assert.rejects(checked, /publishConfig/);
  }
});

test('all packed dependency fields reject local/foreign specs; registry semver and npm aliases work', () => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const spec of [
      'workspace:*',
      'file:../a',
      'link:../a',
      'https://example.invalid/a.tgz',
      'git+https://example.invalid/a',
      'latest',
      '',
      'npm:x@file:../a'
    ]) {
      assert.throws(() => checkManifest({ [field]: { x: spec } }, workspaces), /Non-registry/);
    }
  }
  assert.deepEqual(dependency('alias', 'npm:@redemeine/future@^1.0.0'), ['@redemeine/future', '^1.0.0']);
  checkManifest({ dependencies: { alias: 'npm:public-name@^1.0.0', immer: '^10.2.0' } }, workspaces);
});

test('private development references allowed; all three private runtime fields and aliases rejected', () => {
  checkManifest({ devDependencies: { '@redemeine/private': '1.0.0' } }, workspaces);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.throws(() => checkManifest({ [field]: { '@redemeine/private': '1.0.0' } }, workspaces), /Private runtime/);
    assert.throws(() => checkManifest({ [field]: { alias: 'npm:@redemeine/private@1.0.0' } }, workspaces), /Private runtime/);
  }
  for (const manifest of [{ private: true }, { dependencies: [] }, { bundledDependencies: ['x'] }, { publishConfig: { registry: 'other' } }]) {
    assert.throws(() => checkManifest(manifest, workspaces));
  }
});

test('selected versions take precedence and runtime/peer/optional aliases order dependencies first', async () => {
  const dep = artifact('@redemeine/future');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const parent = { manifest: { name: 'parent', version: '1.0.0', [field]: { alias: 'npm:@redemeine/future@^1.0.0' } } };
    assert.deepEqual(await dependencyOrder([parent, dep], workspaces, noRead), [dep, parent]);
  }
  const parent = artifact('parent', { '@redemeine/future': '^2.0.0' });
  await assert.rejects(dependencyOrder([parent, dep], workspaces, noRead), /Selected dependency/);
});

test('omitted owned dependency requires valid already-public metadata, without recursive history walks', async () => {
  const parent = artifact('parent', { '@redemeine/future': '^1.0.0', '@foreign/ordinary': '^1.0.0' });
  const good = { name: '@redemeine/future', version: '1.0.1', dependencies: { external: '^1.0.0' } };
  const calls = [];
  assert.deepEqual(
    await dependencyOrder([parent], workspaces, (...args) => {
      calls.push(args);
      return good;
    }),
    [parent]
  );
  assert.deepEqual(calls, [['@redemeine/future', '^1.0.0']]);
  for (const metadata of [
    null,
    {},
    [],
    { ...good, name: 'wrong' },
    { ...good, version: '2.0.0' },
    { ...good, publishConfig: { access: 'restricted' } },
    { ...good, dependencies: { x: 'workspace:*' } },
    { ...good, peerDependencies: { '@redemeine/private': '1.0.0' } }
  ]) {
    await assert.rejects(dependencyOrder([parent], workspaces, () => metadata));
  }
});

test('selected cycles and self cycles fail before publication', async () => {
  const a = artifact('@redemeine/future', { other: '1.0.0' });
  const b = artifact('other', { '@redemeine/future': '1.0.0' });
  await assert.rejects(dependencyOrder([a, b], [...workspaces, workspace('other')], noRead), /Cyclic/);
  await assert.rejects(dependencyOrder([artifact('@redemeine/future', { '@redemeine/future': '1.0.0' })], workspaces, noRead), /Cyclic/);
});

test('owned edges use discovered names, including held/unscoped names, not scope membership guesses', async () => {
  const all = [...workspaces, workspace('ordinary-workspace')];
  const parent = artifact('parent', { '@redemeine/not-owned': '1.0.0', localAlias: 'npm:ordinary-workspace@1.0.0', '@redemeine/cli': '1.0.0' });
  const calls = [];
  const read = (name, version) => {
    calls.push(name);
    return { name, version };
  };
  assert.deepEqual(await dependencyOrder([parent], all, read), [parent]);
  assert.deepEqual(calls, ['ordinary-workspace', '@redemeine/cli']);
  await assert.rejects(
    dependencyOrder([parent], all, () => null),
    /Missing\/invalid metadata/
  );
});

test('static/dynamic/reexport/declaration imports and variable loaders reject private targets', () => {
  for (const text of [
    'import x from "@redemeine/private"',
    'export * from "@redemeine/private/sub"',
    'import("@redemeine/private")',
    'type T = import("@redemeine/private").T',
    'import(path)',
    'require(path)',
    'require("@redemeine/private/sub")'
  ]) {
    assert.throws(() => checkImports(text, 'index.ts', ['@redemeine/private']), /Private import|Uninspectable loader/);
  }
  checkImports('import x from "@redemeine/future"; import("immer"); require("immer")', 'index.js', ['@redemeine/private']);
});

test('declaration import-equals requires an inspectable public module target', () => {
  for (const target of ['"@redemeine/private"', '"@redemeine/private/types"', '"file:../private"', 'path']) {
    assert.throws(
      () => checkImports(`import T = require(${target});`, 'index.d.ts', ['@redemeine/private']),
      /Private import|Local import|Uninspectable loader/
    );
  }
  checkImports('import T = require("@redemeine/future"); import Alias = T.Types;', 'index.d.ts', ['@redemeine/private']);
});

test('global require aliases and actual Node createRequire bindings fail closed', () => {
  for (const target of ['"@redemeine/private"', '"immer"', 'path']) {
    assert.throws(() => checkImports(`const load = require; load(${target});`, 'index.js', []), /Unsupported loader alias/);
  }
  for (const module of ['node:module', 'module']) {
    for (const text of [
      `import { createRequire } from "${module}"; createRequire(import.meta.url)("@redemeine/private");`,
      `import { createRequire as make } from "${module}"; const load = make(import.meta.url); load(path);`,
      `import { createRequire as make } from "${module}"; const alias = make; alias(import.meta.url)("immer");`,
      `import * as mod from "${module}"; mod.createRequire(import.meta.url)("@redemeine/private");`,
      `import mod from "${module}"; mod.createRequire(import.meta.url)("immer");`,
      `import * as mod from "${module}"; mod["createRequire"](import.meta.url)("@redemeine/private");`,
      `import * as mod from "${module}"; mod[method](import.meta.url)(path);`
    ])
      assert.throws(() => checkImports(text, 'index.js', ['@redemeine/private']), /Unsupported (createRequire loader|loader alias)/);
  }
});

test('innocent names and nearest lexical bindings are not mistaken for Node loaders', () => {
  for (const text of [
    'function createRequire() { return () => {}; } createRequire(import.meta.url)("@redemeine/private");',
    'const createRequire = () => () => {}; const alias = createRequire; alias()(path);',
    'function f(require) { const load = require; load("@redemeine/private"); require(path); }',
    'const require = (x) => x; const load = require; load(path);',
    '{ const load = require; function require(x) { return x; } load(path); }',
    'import { createRequire as make } from "other"; make(import.meta.url)(path);',
    'import { createRequire as make } from "node:module"; function f(make) { make(import.meta.url)(path); }',
    'import * as mod from "node:module"; function f(mod) { mod.createRequire(import.meta.url)(path); }',
    'import { createRequire } from "node:module"; import * as mod from "node:module"; mod.isBuiltin("fs");',
    'import { require } from "other"; const load = require; load(path);',
    'var __require = typeof require !== "undefined" ? require : (x) => { throw Error(x); };'
  ])
    checkImports(text, 'index.js', ['@redemeine/private']);
  assert.throws(() => checkImports('function f(require) {} const load = require; load(path);', 'index.js', []), /Unsupported loader alias/);
});
