import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runConsumer, runConsumers } from '../consumer-runner.mjs';
import { smokePlan } from '../consumer-smokes.mjs';
import { stage } from '../quarantine.mjs';
import { manifest, put } from '../test/fixtures.mjs';
import { consumerHarness } from './harness.mjs';

function dual(name) {
  const conditions = {
    node: { import: { types: './dist/esm.d.mts', default: './dist/esm.mjs' }, require: { types: './dist/cjs.d.cts', default: './dist/cjs.cjs' } },
    default: { types: './dist/esm.d.mts', default: './dist/fallback.mjs' }
  };
  return manifest(name, { type: 'module', exports: { '.': conditions, './extra': conditions, './blocked': null } });
}

async function distribution(fixture, broken = false) {
  const directory = resolve(fixture.root, 'nested/group/p0/dist');
  await put(resolve(directory, 'esm.mjs'), 'export const value=42;');
  await put(resolve(directory, 'esm.d.mts'), 'export declare const value:number;');
  await put(resolve(directory, 'cjs.cjs'), `exports.value=${broken ? 0 : 42};`);
  await put(resolve(directory, 'cjs.d.cts'), 'export declare const value:number;');
  await put(resolve(directory, 'fallback.mjs'), "throw Error('Non-Node fallback must not execute');");
}

async function requireOnly(fixture) {
  await distribution(fixture);
  const directory = resolve(fixture.root, 'nested/group/p1/dist');
  await put(resolve(directory, 'cjs.cjs'), 'exports.value=42;');
  await put(resolve(directory, 'cjs.d.cts'), 'export declare const value:number;');
}

test('advertised Node import/require conditions and subpaths execute actual targets and strict declarations on both Nodes', { timeout: 600000 }, async (t) => {
  const only = manifest('@fixture/require', { exports: { '.': { require: { types: './dist/cjs.d.cts', default: './dist/cjs.cjs' } } } });
  const h = await consumerHarness(t, [dual('@fixture/dual'), only], [], requireOnly);
  await stage(h.state, h.input, h.selection, h.registry, h.images[0]);
  await runConsumers(h.state, h.input, h.selection, h.registry, h.images, h.plans);
  assert.equal(h.state.report.consumers.length, 4);
  for (const consumer of h.state.report.consumers) {
    assert.equal(consumer.exitCode, 0);
    const dual = consumer.root[0] === '@fixture/dual@1.0.0';
    assert.equal(consumer.commands.filter((c) => c.args.includes('-e')).length, dual ? 4 : 1);
    assert.equal(consumer.commands.filter((c) => c.args.includes('/opt/consumer-tools/node_modules/typescript/bin/tsc')).length, dual ? 3 : 1);
  }
});

test('a broken advertised CJS branch fails both runtime receipts rather than being hidden by working ESM', { timeout: 600000 }, async (t) => {
  const h = await consumerHarness(t, [dual('@fixture/broken')], [], (fixture) => distribution(fixture, true));
  await stage(h.state, h.input, h.selection, h.registry, h.images[0]);
  await assert.rejects(runConsumers(h.state, h.input, h.selection, h.registry, h.images, h.plans), (error) => error.code === 1);
  assert.deepEqual(
    h.state.report.consumers.map((c) => c.exitCode),
    [1, 1]
  );
});

test('require-only and default-CJS export advertisements do not invent an ESM-only contract', () => {
  const requireOnly = smokePlan({ manifest: dual('@fixture/only') });
  assert.deepEqual(requireOnly.surfaces[0].targets, { import: './dist/esm.mjs', require: './dist/cjs.cjs' });
  const pkg = manifest('@fixture/only', { exports: { '.': { require: './dist/index.cjs' } } });
  assert.deepEqual(smokePlan({ manifest: pkg }).surfaces[0].modes, ['require']);
  assert.deepEqual(smokePlan({ manifest: { ...pkg, exports: './dist/index.cjs' } }).surfaces[0].modes, ['import', 'require']);
});

test('strict CJS declaration branch detects an undeclared type dependency despite healthy ESM and runtime exports', { timeout: 600000 }, async (t) => {
  const h = await consumerHarness(t, [dual('@fixture/types')], [], async (fixture) => {
    await distribution(fixture);
    await put(
      resolve(fixture.root, 'nested/group/p0/dist/cjs.d.cts'),
      "import type {Missing} from 'undeclared-consumer-type-host'; export declare const value:number; export type Leak=Missing;"
    );
  });
  await stage(h.state, h.input, h.selection, h.registry, h.images[0]);
  await assert.rejects(runConsumers(h.state, h.input, h.selection, h.registry, h.images, h.plans), (error) => error.code === 1);
  for (const consumer of h.state.report.consumers) {
    const types = consumer.commands.filter((c) => c.args.includes('/opt/consumer-tools/node_modules/typescript/bin/tsc'));
    assert.deepEqual(
      types.map((c) => c.exit),
      [0, 0, 2]
    );
    assert.match(types[2].log, /undeclared-consumer-type-host/);
  }
  assert.equal(h.state.report.consumers.length, 2);
});

test('F3 nested null blocks outer default, while an unmatched nested condition falls through on both Nodes', { timeout: 600000 }, async (t) => {
  const blocked = manifest('@fixture/nested-null', {
    type: 'module',
    exports: {
      '.': { node: { import: null, require: './dist/index.cjs' }, default: './dist/index.js' }
    }
  });
  const unmatched = manifest('@fixture/no-match', {
    type: 'module',
    exports: {
      '.': { node: { require: './dist/index.cjs' }, default: './dist/index.js' }
    }
  });
  const h = await consumerHarness(t, [blocked, unmatched], [], async (fixture) => {
    for (const index of [0, 1]) {
      await put(resolve(fixture.root, `nested/group/p${index}/dist/index.cjs`), 'exports.value=42;');
      await put(resolve(fixture.root, `nested/group/p${index}/dist/index.d.cts`), 'export declare const value:number;');
    }
  });
  const plan = h.plans.find((p) => p.root === '@fixture/nested-null@1.0.0').smoke.surfaces[0];
  assert.deepEqual(plan.targets, { require: './dist/index.cjs' });
  assert.deepEqual(plan.blockedModes, ['import']);
  await stage(h.state, h.input, h.selection, h.registry, h.images[0]);
  await runConsumers(h.state, h.input, h.selection, h.registry, h.images, h.plans);
  assert.equal(h.state.report.consumers.length, 4);
  for (const consumer of h.state.report.consumers.filter((c) => c.root[0] === '@fixture/nested-null@1.0.0')) {
    assert.equal(consumer.exitCode, 0);
    assert(consumer.commands.some((c) => c.args.some((arg) => arg.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'))));
  }
});

test('F3 unsupported conditional arrays are incomplete2, not guessed fallbacks', () => {
  for (const value of [['./dist/index.js'], { node: { import: [null, './dist/index.js'] }, default: './dist/index.js' }]) {
    assert.throws(
      () => smokePlan({ manifest: manifest('@fixture/array', { exports: { '.': value } }) }),
      (error) => error.code === 2
    );
  }
});
