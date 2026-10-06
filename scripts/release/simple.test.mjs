import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { checkContent } from './artifacts.mjs';
import { registryClient } from './registry.mjs';
import { checkImports, checkManifest, chooseVersion, dependencyOrder, eligible, selectCandidates, verifyFiles } from './simple-check.mjs';
import { approve, publishArgs } from './simple.mjs';
import { hash } from './workspace.mjs';

const policy = { holds: { '@redemeine/cli': {} }, knownBad: { '@redemeine/aggregate': ['0.2.0-pre.0'] }, internalScopes: ['@redemeine'] };
const workspace = (name, version = '1.0.0', privateFlag = false) => ({ name, version, manifest: { name, version, private: privateFlag } });
const workspaces = [workspace('@redemeine/future'), workspace('@redemeine/cli'), workspace('@redemeine/private', '1.0.0', true)];
const artifact = (name, dependencies = {}) => ({ manifest: { name, version: '1.0.0', dependencies }, candidate: true });

test('future nonprivate workspace is eligible without a name allowlist; CLI and private remain excluded', () => {
  assert.deepEqual(eligible(workspaces, policy).map((w) => w.name), ['@redemeine/future']);
});

test('already-published versions are skipped, including broken historical versions not needed by the new graph', async () => {
  const inventory = [...workspaces, workspace('@redemeine/aggregate', '0.2.0-pre.0')];
  const client = { metadata: async (name) => ({ versions: name === '@redemeine/aggregate' ? { '0.2.0-pre.0': {} } : {} }) };
  const selected = await selectCandidates(inventory, policy, client);
  assert.deepEqual(selected.candidates.map((w) => w.name), ['@redemeine/future']);
  assert.deepEqual(selected.skipped, ['@redemeine/aggregate@0.2.0-pre.0']);
});

test('healthy numeric dependencies pass; workspace, local, private runtime and bad versions fail', () => {
  checkManifest({ name: '@redemeine/future', version: '1.0.0', dependencies: { immer: '^10.2.0' }, devDependencies: { '@redemeine/private': '1.0.0' } }, workspaces, policy);
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
  assert.deepEqual(args, ['publish', '/tmp/checked.tgz', '--ignore-scripts', '--access', 'public', '--provenance=false', '--tag', 'pre', '--registry', 'https://registry.npmjs.org/']);
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
  } finally { await rm(directory, { recursive: true, force: true }); }
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
