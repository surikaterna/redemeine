import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { c } from 'tar';
import ts from 'typescript';
import { checkContent } from './artifacts.mjs';
import { registryClient } from './registry.mjs';
import { approve, publishArgs } from './simple.mjs';
import { checkArtifact, checkImports, checkManifest, chooseVersion, dependencyOrder, eligible, selectCandidates, verifyFiles } from './simple-check.mjs';
import { hash } from './workspace.mjs';

const policy = { holds: { '@redemeine/cli': {} }, knownBad: { '@redemeine/aggregate': ['0.2.0-pre.0'] }, internalScopes: ['@redemeine'] };
const workspace = (name, version = '1.0.0', privateFlag = false) => ({ name, version, manifest: { name, version, private: privateFlag } });
const workspaces = [workspace('@redemeine/future'), workspace('@redemeine/cli'), workspace('@redemeine/private', '1.0.0', true)];
const artifact = (name, dependencies = {}) => ({ manifest: { name, version: '1.0.0', dependencies }, candidate: true });

async function checkSourceArtifact(extension, text) {
  const directory = await mkdtemp(resolve(tmpdir(), 'simple-source-'));
  const manifest = { name: '@redemeine/future', version: '1.0.0', exports: `./index.${extension}`, dependencies: { immer: '^10.2.0' } };
  const license = Buffer.from('fixture license');
  try {
    const root = resolve(directory, 'package');
    await mkdir(root);
    await writeFile(resolve(root, 'package.json'), JSON.stringify(manifest));
    await writeFile(resolve(root, 'LICENSE'), license);
    await writeFile(resolve(root, `index.${extension}`), text);
    const file = resolve(directory, 'candidate.tgz');
    await c({ cwd: directory, file, gzip: true }, ['package']);
    return await checkArtifact(file, manifest, workspaces, policy, license);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('packed source scanning retains JS, TS, module and declaration suffixes', async () => {
  for (const extension of ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts', 'd.ts', 'd.cts', 'd.mts']) {
    await checkSourceArtifact(extension, 'import "immer";');
    await assert.rejects(checkSourceArtifact(extension, 'import "@redemeine/private";'), /Private import: @redemeine\/private/);
  }
});

for (const extension of ['jsx', 'tsx']) {
  test(`packed .${extension} exports accept public JSX and reject private imports inside its AST`, async () => {
    const annotation = extension === 'tsx' ? ': unknown' : '';
    const text = `import "immer"; const view${annotation} = <section>{import("immer")}</section>;`;
    const source = ts.createSourceFile(`index.${extension}`, text, ts.ScriptTarget.Latest, true);
    assert.equal(source.scriptKind, extension === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
    assert.deepEqual(source.parseDiagnostics, []);
    assert.ok(ts.isJsxElement(source.statements[1].declarationList.declarations[0].initializer));
    await checkSourceArtifact(extension, text);
    await assert.rejects(checkSourceArtifact(extension, text.replace('import "immer"', 'import "@redemeine/private"')), /Private import/);
    await assert.rejects(checkSourceArtifact(extension, text.replace('import("immer")', 'import("@redemeine/private")')), /Private import/);
  });
}

test('future nonprivate workspace is eligible without a name allowlist; CLI and private remain excluded', () => {
  assert.deepEqual(
    eligible(workspaces, policy).map((w) => w.name),
    ['@redemeine/future']
  );
});

test('already-published versions are skipped, including broken historical versions not needed by the new graph', async () => {
  const inventory = [...workspaces, workspace('@redemeine/aggregate', '0.2.0-pre.0')];
  const client = { metadata: async (name) => ({ versions: name === '@redemeine/aggregate' ? { '0.2.0-pre.0': {} } : {} }) };
  const selected = await selectCandidates(inventory, policy, client);
  assert.deepEqual(
    selected.candidates.map((w) => w.name),
    ['@redemeine/future']
  );
  assert.deepEqual(selected.skipped, ['@redemeine/aggregate@0.2.0-pre.0']);
});

test('healthy numeric dependencies pass; workspace, local, private runtime and bad versions fail', () => {
  checkManifest(
    { name: '@redemeine/future', version: '1.0.0', dependencies: { immer: '^10.2.0' }, devDependencies: { '@redemeine/private': '1.0.0' } },
    workspaces,
    policy
  );
  for (const spec of ['workspace:*', 'file:../kernel', 'link:../kernel', 'npm:other@1.0.0', 'https://example.invalid/a.tgz']) {
    assert.throws(() => checkManifest({ dependencies: { x: spec } }, workspaces, policy), /Non-registry/);
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.throws(() => checkManifest({ [field]: { '@redemeine/private': '1.0.0' } }, workspaces, policy), /Private runtime/);
  }
  assert.throws(() => checkManifest({ name: '@redemeine/aggregate', version: '0.2.0-pre.0' }, workspaces, policy), /Known broken/);
});

test('missing JS or declaration export is rejected by reused packed-content inspector', () => {
  for (const target of ['./dist/index.js', './dist/index.d.ts']) {
    const report = { diagnostics: [] };
    checkContent({ manifest: { exports: { '.': target } }, entries: [] }, report, {});
    assert.match(report.diagnostics[0].message, /Missing packed target/);
  }
});

test('private static, dynamic and declaration imports and variable loaders are rejected', () => {
  const names = ['@redemeine/private'];
  for (const text of ['import x from "@redemeine/private"', 'import("@redemeine/private")', 'type T = import("@redemeine/private").T', 'import(path)']) {
    assert.throws(() => checkImports(text, 'index.ts', names), /Private import|Uninspectable loader/);
  }
  checkImports('import x from "@redemeine/future"; import("immer")', 'index.js', names);
});

test('declaration import-equals requires an inspectable public module target', () => {
  const names = ['@redemeine/private'];
  for (const target of ['"@redemeine/private"', '"@redemeine/private/types"', '"file:../private"', 'path']) {
    assert.throws(() => checkImports(`import T = require(${target});`, 'index.d.ts', names), /Private import|Local import|Uninspectable loader/);
  }
  checkImports('import T = require("@redemeine/future"); import Alias = T.Types;', 'index.d.ts', names);
});

test('global require aliases fail closed even with public or computed targets', () => {
  for (const target of ['"@redemeine/private"', '"immer"', 'path']) {
    assert.throws(() => checkImports(`const load = require; load(${target});`, 'index.js', ['@redemeine/private']), /Unsupported loader alias/);
  }
  assert.throws(() => checkImports('require("@redemeine/private/subpath")', 'index.cjs', ['@redemeine/private']), /Private import/);
  assert.throws(() => checkImports('require(path)', 'index.cjs', []), /Uninspectable loader/);
  checkImports('require("immer"); import("immer")', 'index.js', []);
});

test('actual Node createRequire imports fail closed including aliases and namespace access', () => {
  for (const module of ['node:module', 'module']) {
    for (const text of [
      `import { createRequire } from "${module}"; createRequire(import.meta.url)("@redemeine/private");`,
      `import { createRequire as make } from "${module}"; const load = make(import.meta.url); load(path);`,
      `import { createRequire as make } from "${module}"; const alias = make; alias(import.meta.url)("immer");`,
      `import * as mod from "${module}"; mod.createRequire(import.meta.url)("@redemeine/private");`,
      `import mod from "${module}"; mod.createRequire(import.meta.url)("immer");`,
      `import * as mod from "${module}"; mod["createRequire"](import.meta.url)("@redemeine/private");`,
      `import * as mod from "${module}"; mod[method](import.meta.url)(path);`
    ]) {
      assert.throws(() => checkImports(text, 'index.js', ['@redemeine/private']), /Unsupported (createRequire loader|loader alias)/);
    }
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
  ]) {
    checkImports(text, 'index.js', ['@redemeine/private']);
  }
  assert.throws(() => checkImports('function f(require) {} const load = require; load(path);', 'index.js', []), /Unsupported loader alias/);
});

test('missing sibling and stale known-bad versions fail rather than guessing a registry resolution', () => {
  assert.throws(() => chooseVersion('@redemeine/aggregate', '0.2.0-pre.1', [], { versions: {} }, policy), /No candidate/);
  assert.throws(() => chooseVersion('@redemeine/aggregate', '0.2.0-pre.0', [], { versions: { '0.2.0-pre.0': {} } }, policy), /known broken/);
  assert.equal(chooseVersion('@redemeine/future', '^1.0.0', [artifact('@redemeine/future')], { versions: {} }, policy), '1.0.0');
});

test('runtime, peer and optional edges order dependencies first; cycles fail', () => {
  const dep = artifact('@redemeine/future');
  const parent = artifact('@redemeine/parent', { '@redemeine/future': '1.0.0' });
  assert.deepEqual(dependencyOrder([parent, dep], workspaces, policy), [dep, parent]);
  assert.throws(() => dependencyOrder([parent], workspaces, policy), /missing owned/);
  assert.throws(() => dependencyOrder([artifact('@redemeine/future', { '@redemeine/future': '1.0.0' })], workspaces, policy), /Cyclic/);
});

test('approval is exact and explicit, and publisher arguments point at a file with scripts disabled', () => {
  const plan = { artifacts: [artifact('@redemeine/future')] };
  approve(plan, '@redemeine/future@1.0.0', 'pre');
  assert.throws(() => approve(plan, '@redemeine/future@0.9.0', 'pre'), /Approval/);
  assert.throws(() => approve(plan, '@redemeine/future@1.0.0', undefined), /explicitly/);
  const args = publishArgs('/tmp/checked.tgz', 'pre');
  assert.deepEqual(args, [
    'publish',
    '/tmp/checked.tgz',
    '--ignore-scripts',
    '--access',
    'public',
    '--provenance=false',
    '--tag',
    'pre',
    '--registry',
    'https://registry.npmjs.org/'
  ]);
  plan.artifacts[0].manifest.version = '1.0.1-pre.0';
  assert.throws(() => approve(plan, '@redemeine/future@1.0.1-pre.0', 'latest'), /Exit Changesets/);
});

test('changed artifact bytes cannot reach publication', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'simple-release-'));
  try {
    await writeFile(resolve(directory, 'candidate.tgz'), 'original');
    const plan = { artifacts: [{ ...artifact('@redemeine/future'), file: 'candidate.tgz', sha256: hash('original') }] };
    await verifyFiles(directory, plan);
    await writeFile(resolve(directory, 'candidate.tgz'), 'changed');
    await assert.rejects(verifyFiles(directory, plan), /Changed artifact/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('workflow has no release-event or recursive publisher bypass and isolates npm credentials', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /types: \[published\]|pnpm -r publish|id-token: write|pull_request_target/);
  assert.match(workflow, /environment: npm-release/);
  assert.match(workflow, /vars.NPM_RELEASE_ENABLED/);
  assert.match(workflow, /artifact-ids: \$\{\{ needs.qualify.outputs.artifact_id \}\}/);
  assert.equal((workflow.match(/secrets.NPM_TOKEN/g) || []).length, 2);
  assert.ok(workflow.indexOf('verify-public') < workflow.indexOf('simple.mjs promote'));
  for (const use of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(use[1], /@[a-f0-9]{40}$/);
});

test('only an actual registry 404 is absence; authentication/server errors fail closed', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'simple-registry-'));
  const original = globalThis.fetch;
  try {
    const client = await registryClient({ registry: 'https://registry.npmjs.org/' }, null, directory, { registrySnapshots: [] });
    for (const status of [401, 403, 500]) {
      globalThis.fetch = async () => new Response('', { status });
      await assert.rejects(client.metadata(`@redemeine/error-${status}`), /Registry HTTP/);
    }
    globalThis.fetch = async () => new Response('', { status: 404 });
    assert.deepEqual((await client.metadata('@redemeine/missing')).versions, {});
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});
