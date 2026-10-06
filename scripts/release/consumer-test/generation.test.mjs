import assert from 'node:assert/strict';
import { appendFile, chmod, copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { createContainer, docker, inspectOwned } from '../consumer-docker.mjs';
import { stage } from '../quarantine.mjs';
import { manifest, put } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';
import { consumerHarness } from './harness.mjs';

const packages = [
  manifest('@fixture/cli-generator', {
    type: 'module',
    bin: { redemeine: './dist/bin.mjs' },
    peerDependencies: { '@redemeine/aggregate': 'workspace:*' },
    dependencies: { zod: 'workspace:@fixture/schema@*' }
  }),
  manifest('@redemeine/aggregate', { type: 'module' }),
  manifest('@fixture/schema', { type: 'module' })
];

async function prepare(fixture) {
  await appendFile(resolve(fixture.root, 'pnpm-workspace.yaml'), "  - '!nested/**/dist/**'\n");
  const bin = resolve(fixture.root, 'nested/group/p0/dist/bin.mjs');
  await copyFile(new URL('./generation-bin.mjs', import.meta.url), bin);
  await chmod(bin, 0o755);
  const host = resolve(fixture.root, 'nested/group/p1/dist');
  await put(resolve(host, 'index.js'), "export const initialState={id:'',accepted:false}; export const accept=(payload)=>({payload});");
  await put(
    resolve(host, 'index.d.ts'),
    'export declare const initialState:{id:string;accepted:boolean}; export declare function accept(payload:{id:string}):{payload:{id:string}};'
  );
  const schema = resolve(fixture.root, 'nested/group/p2/dist');
  const original = dirname(createRequire(import.meta.url).resolve('zod/package.json'));
  for (const name of ['index.js', 'index.d.ts', 'v4', 'LICENSE']) await cp(resolve(original, name), resolve(schema, name), { recursive: true });
  await put(resolve(fixture.root, 'fixture-source.json'), {
    purpose: 'Checker facade only; no product CLI/aggregate qualification',
    schemaLibrary: 'zod from frozen root dev install, repackaged as fixture-only @fixture/schema alias',
    originalSchemaVersion: JSON.parse(await readFile(resolve(original, 'package.json'), 'utf8')).version,
    aggregateHost: 'synthetic declared required peer with valid TypeScript input; installed through npm graph, never direct sibling/override'
  });
}

async function runDriver(h, image) {
  const directory = resolve(h.state.output, `generator-${image.version}`);
  await mkdir(directory);
  const job = {
    endpoint: h.registry.endpoint,
    roots: ['@fixture/cli-generator@1.0.0'],
    owned: h.input.graph.owned,
    graph: h.input.graph.edges,
    artifacts: h.input.artifacts.map((a) => ({ manifest: a.manifest, sha256: a.sha256, integrity: a.integrity }))
  };
  await writeFile(resolve(directory, 'job.json'), JSON.stringify(job));
  for (const name of ['cli-generation.mjs', 'declarations.mjs', 'verify.mjs'])
    await copyFile(new URL(`../consumer-runtime/${name}`, import.meta.url), resolve(directory, name));
  await copyFile(new URL('./generation-driver.mjs', import.meta.url), resolve(directory, 'driver.mjs'));
  const id = await createContainer(h.state, image.id, h.registry.internal, ['--entrypoint', 'node'], ['/job/driver.mjs']);
  await docker(['cp', directory, `${id}:/job`]);
  const identity = await inspectOwned(h.state, id, h.registry.internal, image.id);
  await docker(['start', id]);
  assert.equal(await docker(['wait', id], 600000), '0');
  await docker(['cp', `${id}:/job/.`, directory]);
  const bytes = await readFile(resolve(directory, 'result.json'));
  const result = JSON.parse(bytes);
  h.state.report.consumers.push({ ...result, identity, receiptSha256: hash(bytes) });
  return result;
}

function assertCases(result) {
  assert.equal(result.setupError, undefined);
  const cases = Object.fromEntries(result.cases.map((entry) => [entry.name, entry]));
  assert.equal(cases.valid.exitCode, 0);
  assert.equal(cases.valid.cliGeneration.schemaBehavior, 'passed');
  assert.deepEqual(cases.valid.generatedCompilation.files, ['generated.ts', 'generated-check.ts']);
  for (const name of ['syntax', 'types', 'comment', 'empty']) {
    assert.equal(cases[name].cliInput.typecheckExit, 0);
    assert.equal(cases[name].exitCode, 1);
    assert.equal(cases[name].cliGeneration.generatedTypes, 'failed');
    assert.equal(cases[name].cliGeneration.schemaBehavior, 'not-run');
  }
  for (const name of ['coerce-id', 'coerce-state']) {
    assert.equal(cases[name].exitCode, 1);
    assert.equal(cases[name].cliGeneration.generatedTypes, 'passed');
    assert.equal(cases[name].cliGeneration.schemaBehavior, 'failed');
  }
  assert.equal(cases['bad-input'].exitCode, 1);
  assert.equal(cases['bad-input'].cliGeneration.input, 'failed');
  assert.equal(cases['bad-input'].cliGeneration.extraction, 'not-run');
  assert.equal(cases['missing-host'].exitCode, 2);
  assert.equal(cases['missing-host'].failureKind, 'coverage-incomplete');
  assert.equal(cases['missing-host'].commands.length, 0);
  assert.equal(cases['missing-host'].cliGeneration.status, 'blocked');
}

test('F1/F2 installed checker facade: valid required peer, actual generated compilation/behavior and invalid-output controls on both Nodes', {
  timeout: 1200000
}, async (t) => {
  const h = await consumerHarness(t, packages, [], prepare, false);
  await stage(h.state, h.input, h.selection, h.registry, h.images[0]);
  for (const image of h.images) assertCases(await runDriver(h, image));
  assert.deepEqual(
    h.state.report.consumers.map((result) => result.node),
    ['22.23.3', '24.20.0']
  );
});
