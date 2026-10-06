import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { cleanup, docker, dockerRun, provision, tools } from '../consumer-docker.mjs';

test('cleanup removes only run image tags, preserves shared images and receipts, and is repeatable', { timeout: 600000 }, async (t) => {
  const state = dockerRun(await mkdtemp(resolve(tmpdir(), 'consumer-image-cleanup-')), {});
  const tags = tools.nodes.map((node) => `${state.id}:node-${node.version}`);
  const shared = `control-${state.id}:shared`;
  t.after(async () => {
    await cleanup(state);
    for (const tag of [...tags, shared]) {
      if (await docker(['image', 'ls', '-q', '--filter', `reference=${tag}`])) await docker(['image', 'rm', tag]);
    }
  });
  const images = await provision(state);
  await docker(['image', 'tag', images[0].id, shared]);
  assert.equal(await cleanup(state), true);
  for (const tag of tags) assert.equal(await docker(['image', 'ls', '-q', '--filter', `reference=${tag}`]), '', `Leaked ${tag}`);
  assert.equal(JSON.parse(await docker(['image', 'inspect', shared]))[0].Id, images[0].id);
  assert.deepEqual(state.report.images, images);
  assert.equal(state.report.imageCleanup.length, 2);
  await writeFile(resolve(state.output, 'receipt.json'), JSON.stringify(state.report, null, 2));
  assert.equal(await cleanup(state), true);
  console.log(`Image cleanup evidence: ${state.output}`);
});

test('partial provisioning tags reconcile; identity conflicts fail cleanup without deleting foreign tags', async (t) => {
  const state = dockerRun(await mkdtemp(resolve(tmpdir(), 'consumer-image-partial-')), {});
  const tag = `${state.id}:node-${tools.nodes[0].version}`;
  t.after(async () => {
    state.imageTags = [{ tag }];
    assert(await cleanup(state));
  });
  await docker(['image', 'tag', tools.nodes[0].image, tag]);
  state.imageTags.push({ tag, id: 'sha256:unexpected' });
  assert.equal(await cleanup(state), false);
  assert.deepEqual(state.report.cleanup.failures, [{ resource: tag, operation: 'image tag cleanup' }]);
  assert(await docker(['image', 'ls', '-q', '--filter', `reference=${tag}`]));
  state.imageTags = [{ tag: tools.nodes[0].image }];
  assert.equal(await cleanup(state), false);
  state.imageTags = [{ tag }];
  assert.equal(await cleanup(state), true);
  assert.equal(await docker(['image', 'ls', '-q', '--filter', `reference=${tag}`]), '');
});
