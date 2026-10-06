import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { qualify } from '../consumer.mjs';
import { addRegistry, cli, manifest, workspace } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';

test('actual A tgz -> official pinned Verdaccio -> two isolated npm11 consumers', { timeout: 600000 }, async (t) => {
  const hooks = {
    prepack: "node -e \"require('fs').writeFileSync('/tmp/LIFECYCLE_TRAP','bad')\"",
    prepare: 'node -e "throw Error(\'LIFECYCLE_TRAP\')"',
    install: 'node -e "throw Error(\'LIFECYCLE_TRAP\')"',
    postinstall: 'node -e "throw Error(\'LIFECYCLE_TRAP\')"'
  };
  const fixture = await workspace([
    manifest('@fixture/one', {
      scripts: hooks,
      dependencies: { 'alias..dots': 'npm:@fixture/original@1.0.0' },
      optionalDependencies: { '@fixture/optional..dots': '^1.0.0' },
      peerDependencies: { '@fixture/host': '^1.0.0' }
    })
  ]);
  for (const name of ['@fixture/original', '@fixture/optional..dots', '@fixture/host']) {
    await addRegistry(fixture, name, [manifest(name, { scripts: hooks })]);
  }
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.equal((await cli(fixture)).status, 0);
  const parent = await mkdtemp(resolve(tmpdir(), 'consumer-docker-proof-'));
  const path = resolve(fixture.output, 'manifest.json');
  const report = await qualify(
    { manifest: path, 'manifest-sha256': hash(await readFile(path)), output: resolve(parent, 'result'), root: [] },
    await readFile(resolve(fixture.root, 'scripts/release/policy.json'))
  );
  console.log(`Consumer evidence: ${parent}/result`);
  assert.equal(report.exitCode, 0, JSON.stringify(report, null, 2));
  assert.equal(report.staging.receipts.length, 4);
  assert.deepEqual(
    report.consumers.map((c) => [c.node, c.npm]),
    [
      ['22.23.3', '11.19.0'],
      ['24.20.0', '11.19.0']
    ]
  );
  assert(report.consumers.every((c) => c.cache.every((a) => report.staging.receipts.some((s) => s.sha256 === a.sha256))));
  for (const consumer of report.consumers) {
    assert(consumer.cache.some((a) => a.path === 'node_modules/alias..dots'));
    assert(consumer.cache.some((a) => a.path === 'node_modules/@fixture/optional..dots'));
  }
  assert(report.cleanup.complete);
});
