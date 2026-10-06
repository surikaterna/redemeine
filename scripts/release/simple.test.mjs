import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { c } from 'tar';
import ts from 'typescript';
import { checkContent } from './artifacts.mjs';
import { registryClient } from './registry.mjs';
import { approve, authorize, publishArgs } from './simple.mjs';
import { checkArtifact, checkImports, checkManifest, chooseVersion, dependencyOrder, eligible, selectCandidates, verifyFiles } from './simple-check.mjs';
import { hash } from './workspace.mjs';

const policy = { holds: { '@redemeine/cli': {} }, knownBad: { '@redemeine/aggregate': ['0.2.0-pre.0'] }, internalScopes: ['@redemeine'] };
const workspace = (name, version = '1.0.0', privateFlag = false) => ({ name, version, manifest: { name, version, private: privateFlag } });
const workspaces = [workspace('@redemeine/future'), workspace('@redemeine/cli'), workspace('@redemeine/private', '1.0.0', true)];
const artifact = (name, dependencies = {}) => ({ manifest: { name, version: '1.0.0', dependencies }, candidate: true });

async function releaseWorkflow() {
  // Reuse Jest's locked YAML parser without adding a release/runtime dependency.
  let require = createRequire(import.meta.url);
  for (const name of ['jest', 'jest-cli', 'jest-config']) require = createRequire(require.resolve(name));
  const text = await readFile(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8');
  return { text, workflow: require('js-yaml').load(text) };
}

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
    '--provenance',
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

test('OIDC authorization requires every context field; token-only fails without requests or subprocesses', (t) => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    RELEASE_APPROVED: 'true',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/synthetic-never-requested',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-never-transmitted'
  };
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('No identity or registry requests allowed'));
  const spawn = t.mock.method(childProcess, 'spawnSync', () => assert.fail('No npm calls allowed'));
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => authorize(env));
    for (const field of Object.keys(env)) {
      for (const value of [undefined, '', ' ']) assert.throws(() => authorize({ ...env, [field]: value }));
    }
    for (const [field, value] of [
      ['GITHUB_ACTIONS', 'false'],
      ['GITHUB_REF', 'refs/heads/other'],
      ['GITHUB_EVENT_NAME', 'push'],
      ['RELEASE_APPROVED', 'false']
    ]) {
      assert.throws(() => authorize({ ...env, [field]: value }));
    }
    assert.throws(
      () => authorize({ ...env, ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined, NODE_AUTH_TOKEN: 'token-only-marker' }),
      /Missing GitHub OIDC/
    );
    assert.throws(
      () => authorize({ ...env, ACTIONS_ID_TOKEN_REQUEST_URL: '' }),
      (error) => {
        assert.doesNotMatch(String(error), /synthetic-never|token-only-marker/);
        return /Missing GitHub OIDC request URL/.test(error.message);
      }
    );
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('workflow confines OIDC permission to the protected main/manual publish job with no token fallback', async () => {
  const { text, workflow } = await releaseWorkflow();
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['publish', 'qualify', 'version']);
  assert.deepEqual(workflow.jobs.version.permissions, { contents: 'write', 'pull-requests': 'write' });
  assert.equal(workflow.jobs.qualify.permissions, undefined);
  const publish = workflow.jobs.publish;
  assert.deepEqual(publish.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(publish.environment, 'npm-release');
  assert.equal(publish.if, "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
  assert.equal(publish.needs, 'qualify');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.doesNotMatch(text, /pnpm -r publish|NPM_TOKEN|NODE_AUTH_TOKEN|registry-url|--provenance=false/);
  assert.match(text, /vars.NPM_RELEASE_ENABLED/);
  assert.match(text, /artifact-ids: \$\{\{ needs.qualify.outputs.artifact_id \}\}/);
  const commands = publish.steps.filter((step) => step.run?.startsWith('node scripts/release/simple.mjs'));
  assert.deepEqual(
    commands.map((step) => step.run.split(' ')[2]),
    ['publish', 'verify-public', 'promote']
  );
  for (const step of [commands[0], commands[2]]) assert.equal(step.env.RELEASE_APPROVED, 'true');
  for (const use of text.matchAll(/uses: ([^\s]+)/g)) assert.match(use[1], /@[a-f0-9]{40}$/);
});

test('both release hosts install and assert npm 11.21.0 before driver use; version job stays unchanged', async () => {
  const { workflow } = await releaseWorkflow();
  const install = 'npm install --global npm@11.21.0 --ignore-scripts --registry=https://registry.npmjs.org';
  for (const name of ['qualify', 'publish']) {
    const steps = workflow.jobs[name].steps;
    const index = steps.findIndex((step) => step.run?.split('\n')[0] === install);
    assert.ok(index > steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@')));
    assert.deepEqual(steps[index].run.trim().split('\n'), [install, 'npm --version', 'test "$(npm --version)" = 11.21.0']);
    assert.ok(index < steps.findIndex((step) => /release:check-simple|simple.mjs publish/.test(step.run)));
    assert.equal(steps.filter((step) => step.run?.includes('npm install --global')).length, 1);
    assert.equal(steps.find((step) => step.uses?.startsWith('actions/setup-node@')).with['node-version'], '24.20.0');
  }
  assert.ok(workflow.jobs.version.steps.every((step) => !step.run?.includes('npm install --global')));
});

test('public write operations authorize first and the driver asserts its actual reported host npm version', async () => {
  const text = await readFile(new URL('./simple.mjs', import.meta.url), 'utf8');
  const source = ts.createSourceFile('simple.mjs', text, ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(ts.isFunctionDeclaration);
  for (const name of ['publish', 'promote']) {
    const fn = functions.find((statement) => statement.name.text === name);
    assert.equal(fn.body.statements[0].getText(source), 'authorize();');
  }
  const main = functions.find((statement) => statement.name.text === 'main');
  const assertion = main.body.statements.find((statement) => statement.getText(source).startsWith('assert.equal(report.tools.npm,'));
  assert.equal(assertion.expression.arguments[1].text, '11.21.0');
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
