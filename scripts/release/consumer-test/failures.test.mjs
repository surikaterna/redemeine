import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { docker } from '../consumer-docker.mjs';
import { runConsumer } from '../consumer-runner.mjs';
import { stage } from '../quarantine.mjs';
import { manifest } from '../test/fixtures.mjs';
import { consumerHarness as harness } from './harness.mjs';

test('two genuine fixture roots combine on both runtimes without direct sibling masking', { timeout: 600000 }, async (t) => {
  const packages = ['@fixture/one', '@fixture/two'].map((name) => manifest(name, { peerDependencies: { '@fixture/host': '^1.0.0' } }));
  const h = await harness(t, packages, [manifest('@fixture/host')]);
  const poison = {
    NPM_TOKEN: 'consumer-poison-token',
    NODE_AUTH_TOKEN: 'consumer-poison-token',
    NODE_OPTIONS: '--require=/host-preload-trap.cjs',
    NODE_PATH: '/host-workspace/node_modules',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    npm_config_userconfig: '/host-secret.npmrc',
    HTTPS_PROXY: 'http://127.0.0.1:1'
  };
  const previous = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, poison);
  await stage(h.state, h.input, h.selection, h.registry, h.images[0]);
  for (const image of h.images) await runConsumer(h.state, h.input, h.selection, h.registry, image, h.plans);
  assert(h.state.report.consumers.every((consumer) => consumer.exitCode === 0 && consumer.root.length === 2));
  assert(!JSON.stringify(h.state.report).includes('consumer-poison-token'));
  assert(h.state.report.consumers.every((c) => !('NODE_PATH' in c.environment) && !('NODE_OPTIONS' in c.environment)));
});

test('individually valid required peers collide in a combined consumer without overrides', { timeout: 600000 }, async (t) => {
  const packages = [
    manifest('@fixture/one', { peerDependencies: { '@fixture/host': '^1.0.0' } }),
    manifest('@fixture/two', { peerDependencies: { '@fixture/host': '^2.0.0' } })
  ];
  const h = await harness(t, packages, [manifest('@fixture/host'), manifest('@fixture/host', { version: '2.0.0' })]);
  await stage(h.state, h.input, h.selection, h.registry, h.images[0]);
  await assert.rejects(runConsumer(h.state, h.input, h.selection, h.registry, h.images[0], h.plans), (error) => error.code === 1);
  assert(h.state.report.consumers[0].commands.some((c) => c.log.includes('ERESOLVE')));
});

test('missing staged optional fails even when npm install and ls succeed', { timeout: 600000 }, async (t) => {
  const h = await harness(t, [manifest('@fixture/root', { optionalDependencies: { '@fixture/optional': '^1.0.0' } })], [manifest('@fixture/optional')]);
  const fault = { ...h.selection, order: h.selection.order.filter((key) => !key.startsWith('@fixture/optional@')) };
  await stage(h.state, h.input, fault, h.registry, h.images[0]);
  await assert.rejects(runConsumer(h.state, h.input, h.selection, h.registry, h.images[0], h.plans), (error) => error.code === 1);
  const consumer = h.state.report.consumers[0];
  assert(consumer.commands.filter((c) => c.program === 'npm').every((c) => c.exit === 0));
  assert.match(consumer.error, /missing/);
});

test('mutated copied tarball cannot be published; stopped registry is infrastructure not artifact failure', { timeout: 600000 }, async (t) => {
  const h = await harness(t, [manifest('@fixture/root')], []);
  for (const endpoint of ['https://registry.npmjs.org/', 'http://127.0.0.1:4873/', `${h.registry.endpoint}redirect/`]) {
    await assert.rejects(stage(h.state, h.input, h.selection, { ...h.registry, endpoint }, h.images[0]), /target mismatch/);
  }
  assert.equal(h.state.containers.length, 1, 'A rejected target must not start a stager');
  await writeFile(h.input.artifacts[0].copy, 'mutated');
  await assert.rejects(stage(h.state, h.input, h.selection, h.registry, h.images[0]), (error) => error.code === 2);
  assert.equal(h.state.report.staging.receipts.length, 0);
  assert.equal(h.state.report.staging.commands.length, 0);
  await docker(['stop', h.registry.id]);
  await assert.rejects(stage(h.state, h.input, h.selection, h.registry, h.images[0]), (error) => error.code === 2);
});
