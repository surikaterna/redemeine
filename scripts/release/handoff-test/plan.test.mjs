import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { loadInput } from '../consumer-input.mjs';
import { validateIntent } from '../release-plan-schema.mjs';
import { addRegistry, manifest, put } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';
import { greenFixture, plannedFixture, scopedAudit } from './fixtures.mjs';

test('applied reviewed numeric edge: selected v2 green, separate whole global red, complete B admission', async (t) => {
  const fixture = await greenFixture(t);
  const a = fixture.a;
  assert.equal(a.manifest.schemaVersion, 2);
  assert.equal(a.manifest.artifacts.length, 2);
  assert.equal(a.manifest.edges[0].resolved.origin, 'candidate');
  assert.equal(a.manifest.workspaces.length, 6);
  const path = resolve(a.output, 'manifest.json');
  const input = await loadInput(
    path,
    hash(await readFile(path)),
    resolve(fixture.directory, 'snapshot'),
    await readFile(resolve(fixture.root, 'scripts/release/policy.json'))
  );
  assert.equal(input.verdict, 0);
  assert.equal(input.graph.candidates.length, 2);
  for (const name of ['@fixture/private', '@fixture/held', '@fixture/missing', '@redemeine/cli', '@redemeine/testing']) {
    const intent = structuredClone(fixture.plan.intent);
    intent.selected[0].name = name;
    assert.throws(() => validateIntent(intent, fixture.plan.workspaces, fixture.plan.policy, null));
  }
  const denied = { ...fixture.plan.policy, knownBad: { '@fixture/base': ['1.0.0'] } };
  assert.throws(() => validateIntent(fixture.plan.intent, fixture.plan.workspaces, denied, null));
});

test('unselected ordinary public workspace resolves only recursively audited registry bytes, not its local candidate', async (t) => {
  const fixture = await plannedFixture(t, 'stable', async (fixture) => {
    await put(resolve(fixture.root, 'nested/group/p4/package.json'), manifest('@fixture/seed'));
    await addRegistry(fixture, '@fixture/seed', [manifest('@fixture/seed')]);
    const path = resolve(fixture.root, 'nested/group/p1/package.json');
    const app = JSON.parse(await readFile(path));
    app.dependencies['@fixture/seed'] = '1.0.0';
    await put(path, app);
    fixture.intent.exclusions['@fixture/seed'] = { held: false, reason: 'Registry prerequisite; never repack as candidate' };
  });
  const a = await scopedAudit(fixture);
  assert.equal(a.code, 0, JSON.stringify(a.manifest.diagnostics));
  const path = resolve(a.output, 'manifest.json');
  const input = await loadInput(
    path,
    hash(await readFile(path)),
    resolve(fixture.directory, 'seed-snapshot'),
    await readFile(resolve(fixture.root, 'scripts/release/policy.json'))
  );
  assert(input.manifest.artifacts.some((a) => a.manifest.name === '@fixture/seed' && a.origin === 'fixture-registry'));
  assert(!input.graph.candidates.some((name) => name.startsWith('@fixture/seed')));
});

test('future versions reject before ANY pack; no artificial healthy repo', async (t) => {
  const fixture = await plannedFixture(t, 'stable', async ({ intent }) => {
    intent.selected[0].version = '1.0.1';
    intent.candidateEdges[0].version = '1.0.1';
  });
  assert.equal(fixture.exitCode, 2);
  const a = await scopedAudit(fixture);
  assert.equal(a.code, 2);
  assert.equal(a.manifest.artifacts.length, 0);
  assert(!a.manifest.invocations.some((item) => item.args.includes('pack')));
});

test('scoped required private alias and selected numeric cycle remain violations', async (t) => {
  const privateEdge = await plannedFixture(t, 'stable', async (fixture) => {
    const path = resolve(fixture.root, 'nested/group/p1/package.json');
    const pkg = JSON.parse(await readFile(path));
    pkg.optionalDependencies = { concealed: 'npm:@fixture/private@1.0.0' };
    await put(path, pkg);
  });
  const rejected = await scopedAudit(privateEdge);
  assert.equal(rejected.code, 1);
  assert(rejected.manifest.diagnostics.some((item) => item.code === 'WITHHELD_EDGE'));
  const cycle = await plannedFixture(t, 'stable', async (fixture) => {
    const path = resolve(fixture.root, 'nested/group/p0/package.json');
    const pkg = JSON.parse(await readFile(path));
    pkg.dependencies = { '@fixture/app': '1.0.0' };
    await put(path, pkg);
    fixture.intent.candidateEdges.push({ from: '@fixture/base', field: 'dependencies', name: '@fixture/app', version: '1.0.0' });
  });
  const cyclic = await scopedAudit(cycle);
  assert.equal(cyclic.code, 1);
  assert(cyclic.manifest.diagnostics.some((item) => item.code === 'CANDIDATE_CYCLE'));
});
