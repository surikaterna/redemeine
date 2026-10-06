import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { qualify } from '../consumer.mjs';
import { createHandoff } from '../handoff.mjs';
import { loadEnvelope } from '../handoff-input.mjs';
import { rehearse } from '../publish-rehearsal.mjs';
import { hash } from '../workspace.mjs';
import { conflictControl, publisherFaults } from './faults.mjs';
import { greenFixture } from './fixtures.mjs';
import { mutationMatrix } from './mutations.mjs';
import { runtimeEvidenceCases } from './runtime-evidence.mjs';

async function multipleSurfaces(fixture) {
  for (const name of ['p0', 'p1']) {
    const path = resolve(fixture.root, `nested/group/${name}/package.json`);
    const manifest = JSON.parse(await readFile(path));
    manifest.exports = {
      '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.js' },
      './extra': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.js' },
      './import-only': { types: './dist/index.d.ts', import: './dist/index.js', require: null }
    };
    await writeFile(path, JSON.stringify(manifest));
  }
}

for (const channel of ['stable', 'pre'])
  test(`genuine ${channel} selected A/B both Nodes -> immutable handoff -> exact local npm upload/readback/tag`, { timeout: 900000 }, async (t) => {
    const fixture = await greenFixture(t, channel, multipleSurfaces);
    const a = resolve(fixture.a.output, 'manifest.json');
    const aSha = hash(await readFile(a));
    const bOutput = resolve(fixture.directory, 'b');
    const b = await qualify(
      { manifest: a, 'manifest-sha256': aSha, output: bOutput, root: [] },
      await readFile(resolve(fixture.root, 'scripts/release/policy.json'))
    );
    assert.equal(b.exitCode, 0, JSON.stringify(b));
    assert.equal(b.consumers.length, 4);
    const global = resolve(fixture.globalOutput, 'manifest.json');
    const output = resolve(fixture.directory, 'handoff');
    const handoff = await createHandoff({
      plan: fixture.planPath,
      'plan-sha256': fixture.sha256,
      manifest: a,
      'manifest-sha256': aSha,
      'consumer-result': resolve(bOutput, 'result.json'),
      'consumer-sha256': hash(await readFile(resolve(bOutput, 'result.json'))),
      'global-manifest': global,
      'global-sha256': hash(await readFile(global)),
      output
    });
    const admitted = await loadEnvelope(
      resolve(output, 'envelope.json'),
      handoff.sha256,
      resolve(fixture.directory, 'f1-copy'),
      handoff.envelope.toolsSnapshot
    );
    const f1 = await runtimeEvidenceCases(t, admitted);
    await writeFile(resolve(fixture.directory, 'f1-evidence.json'), JSON.stringify(f1, null, 2));
    const published = await rehearse({
      envelope: resolve(output, 'envelope.json'),
      'envelope-sha256': handoff.sha256,
      output: resolve(fixture.directory, 'publish')
    });
    assert.equal(published.exitCode, 0, JSON.stringify(published));
    assert.equal(published.cleanup.complete, true);
    assert.equal(published.workers.length, 1);
    assert(published.workers[0].ledger.tags.every((entry) => entry.state === 'confirmed'));
    if (channel === 'stable') await mutationMatrix(t, fixture, b, handoff);
    if (channel === 'stable') await publisherFaults(t, fixture, handoff);
    if (channel === 'stable') await conflictControl(t, fixture, handoff);
    console.log(`Fresh ${channel} C receipt: ${fixture.directory}`);
  });
