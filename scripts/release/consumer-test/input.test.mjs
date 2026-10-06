import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { consumerArguments, qualify } from '../consumer.mjs';
import { boundedRead, containedRead } from '../consumer-files.mjs';
import { deniedVersions, selectRoots } from '../consumer-graph.mjs';
import { loadInput } from '../consumer-input.mjs';
import { smokePlan } from '../consumer-smokes.mjs';
import { addRegistry, cli, manifest, policy, put, workspace } from '../test/fixtures.mjs';
import { hash, sri } from '../workspace.mjs';

async function admission(fixture, output, mutate) {
  const path = resolve(fixture.output, 'manifest.json');
  let bytes = await readFile(path);
  if (mutate) {
    const data = JSON.parse(bytes);
    mutate(data);
    bytes = Buffer.from(JSON.stringify(data));
    await writeFile(path, bytes);
  }
  return loadInput(path, hash(bytes), output, await readFile(resolve(fixture.root, 'scripts/release/policy.json')));
}

test('actual A-produced bytes admit, preserve exact tgz and select only after full graph', async (t) => {
  const fixture = await workspace([manifest('@fixture/one')]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.equal((await cli(fixture)).status, 0);
  const input = await admission(fixture, resolve(fixture.root, 'snapshot'));
  assert.equal(input.verdict, 0);
  assert.equal(input.artifacts.length, 1);
  assert.equal(hash(await readFile(input.artifacts[0].copy)), input.artifacts[0].sha256);
  assert.deepEqual(selectRoots(input, []).roots, ['@fixture/one@1.0.0']);
});

test('complete red A input is preserved without touching tarballs or snapshot', async (t) => {
  const fixture = await workspace([manifest('@fixture/red', { dependencies: { private: 'workspace:*' } }), manifest('private', { private: true })]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const a = await cli(fixture);
  assert.equal(a.status, 1);
  await rm(resolve(fixture.output, 'candidate'), { recursive: true });
  const input = await admission(fixture, resolve(fixture.root, 'snapshot'));
  assert.equal(input.verdict, 1);
  assert.deepEqual(input.manifest.diagnostics, a.report.diagnostics);
  assert.equal(input.artifacts, undefined);
});

test('A contradiction, tampering, extra commands and omitted graph fail closed', async (t) => {
  const fixture = await workspace([manifest('@fixture/one', { dependencies: { external: '^1.0.0' } })]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.equal((await cli(fixture)).status, 0);
  const original = await readFile(resolve(fixture.output, 'manifest.json'));
  const mutations = [
    (m) => {
      m.exitCode = 1;
    },
    (m) => {
      m.policy.internalScopes = [];
    },
    (m) => {
      m.commands = ['curl evil'];
    },
    (m) => {
      m.edges = [];
    },
    (m) => {
      m.artifacts[0].archive = '../outside.tgz';
    },
    (m) => {
      m.artifacts[0].sha256 = 'a'.repeat(64);
    },
    (m) => {
      m.artifacts[0].manifest.dependencies = {};
    },
    (m) => {
      m.artifacts[0].entries = [];
    },
    (m) => {
      m.workspaces = m.workspaces.filter((w) => w.name !== '@fixture/one');
    }
  ];
  for (const [index, mutate] of mutations.entries()) {
    await writeFile(resolve(fixture.output, 'manifest.json'), original);
    await assert.rejects(admission(fixture, resolve(fixture.root, `snapshot-${index}`), mutate));
  }
});

test('file boundary rejects links, directories, oversized inputs and unsafe paths', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'consumer-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, '%40fixture%2Fone.json'), 'safe');
  assert.equal((await containedRead(root, '%40fixture%2Fone.json', 4)).toString(), 'safe');
  await symlink(resolve(root, '%40fixture%2Fone.json'), resolve(root, 'link'));
  await assert.rejects(boundedRead(resolve(root, 'link'), 10));
  await assert.rejects(boundedRead(root, 10));
  await assert.rejects(boundedRead(resolve(root, '%40fixture%2Fone.json'), 3));
  for (const path of ['../x', '/etc/passwd', 'a\\b', 'a/../b', 'a//b']) await assert.rejects(containedRead(root, path, 10));
});

test('fixture policy is passed only by test helper, not a CLI policy override', () => {
  assert.equal(policy.internalScopes[0], '@fixture');
  for (const args of [['--allow-red'], ['--registry', 'https://registry.npmjs.org/'], ['--policy', 'fixture'], ['--command', 'true']]) {
    assert.throws(() => consumerArguments(args));
  }
});

test('policy records use own keys for unscoped dependency identities', () => {
  assert.deepEqual(deniedVersions({ knownBad: {} }, 'constructor'), []);
  assert.deepEqual(deniedVersions({ knownBad: { constructor: ['1.0.0'] } }, 'constructor'), ['1.0.0']);
});

test('same identity different bytes fails before Docker; identical original bytes deduplicate with origins', async (t) => {
  const fixture = await workspace([manifest('@fixture/one')]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = await cli(fixture);
  assert.equal(first.status, 0);
  const original = await readFile(resolve(fixture.output, first.report.artifacts[0].archive));
  await addRegistry(fixture, '@fixture/one', [manifest('@fixture/one')]);
  fixture.output = resolve(fixture.root, 'conflicting-a');
  assert.equal((await cli(fixture)).status, 0);
  const options = { manifest: resolve(fixture.output, 'manifest.json'), output: resolve(fixture.root, 'b-conflict'), root: [] };
  options['manifest-sha256'] = hash(await readFile(options.manifest));
  const report = await qualify(options, await readFile(resolve(fixture.root, 'scripts/release/policy.json')));
  assert.equal(report.exitCode, 1);
  assert.equal(report.images, undefined);
  assert.equal(report.staging.receipts.length, 0);
  const tarball = '%40fixture%2Fone-1.0.0.tgz';
  await writeFile(resolve(fixture.registry, tarball), original);
  await put(resolve(fixture.registry, '%40fixture%2Fone.json'), {
    name: '@fixture/one',
    versions: {
      '1.0.0': { ...first.report.artifacts[0].manifest, dist: { tarball, integrity: sri(original) } }
    }
  });
  fixture.output = resolve(fixture.root, 'identical-a');
  assert.equal((await cli(fixture)).status, 0);
  const input = await admission(fixture, resolve(fixture.root, 'identical-snapshot'));
  assert.equal(input.artifacts.length, 1);
  assert.deepEqual(input.artifacts[0].origins, ['candidate', 'fixture-registry']);
});

test('archive symlink and optional-peer coverage fail closed', async (t) => {
  const fixture = await workspace([
    manifest('@fixture/one', { peerDependencies: { '@fixture/host': '*' }, peerDependenciesMeta: { '@fixture/host': { optional: true } } })
  ]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await addRegistry(fixture, '@fixture/host', []);
  assert.equal((await cli(fixture)).status, 0);
  await assert.rejects(admission(fixture, resolve(fixture.root, 'optional')), /Optional-peer/);
  const data = JSON.parse(await readFile(resolve(fixture.output, 'manifest.json')));
  const path = resolve(fixture.output, data.artifacts[0].archive);
  await copyFile(path, resolve(fixture.root, 'outside.tgz'));
  await rm(path);
  await symlink(resolve(fixture.root, 'outside.tgz'), path);
  await assert.rejects(admission(fixture, resolve(fixture.root, 'symlink')), /Symlink/);
});

test('unsupported advertised conditions, wildcard and adapter coverage are incomplete', () => {
  for (const pkg of [
    manifest('not-an-adapter'),
    manifest('@fixture/a', { exports: { '.': { browser: './dist/index.js' } } }),
    manifest('@fixture/a', { exports: { './*': './dist/*.js' } })
  ])
    assert.throws(() => smokePlan({ manifest: pkg }));
});

test('actual A missing/prerelease/cycle/known-bad manifests cannot be narrowed to a green root', async (t) => {
  const cases = [
    { packages: [manifest('@fixture/bad', { dependencies: { '@fixture/dependency': '^1.0.0' } })], registry: [], code: 'UNSATISFIED' },
    {
      packages: [manifest('@fixture/bad', { dependencies: { alias: 'npm:@fixture/dependency@^1.0.0' } })],
      registry: [manifest('@fixture/dependency', { version: '1.0.0-pre.1' })],
      code: 'UNSATISFIED'
    },
    {
      packages: [
        manifest('@fixture/bad', { dependencies: { '@fixture/other': 'workspace:*' } }),
        manifest('@fixture/other', { dependencies: { '@fixture/bad': 'workspace:*' } })
      ],
      registry: [],
      code: 'CANDIDATE_CYCLE'
    },
    { packages: [manifest('@fixture/bad')], registry: [], code: 'KNOWN_BAD_ARTIFACT', policy: { ...policy, knownBad: { '@fixture/bad': ['1.0.0'] } } }
  ];
  for (const item of cases) {
    const fixture = await workspace([manifest('@fixture/good'), ...item.packages], item.policy || policy);
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await addRegistry(fixture, '@fixture/dependency', item.registry);
    const a = await cli(fixture);
    assert.equal(a.status, 1);
    assert(a.report.diagnostics.some((d) => d.code === item.code));
    const path = resolve(fixture.output, 'manifest.json');
    const b = await qualify(
      { manifest: path, 'manifest-sha256': hash(await readFile(path)), output: resolve(fixture.root, 'b'), root: ['@fixture/good@1.0.0'] },
      await readFile(resolve(fixture.root, 'scripts/release/policy.json'))
    );
    assert.equal(b.exitCode, 1);
    assert.equal(b.images, undefined);
    assert.deepEqual(b.input.diagnostics, a.report.diagnostics);
  }
});
