import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { cleanup, dockerRun, provision } from '../consumer-docker.mjs';
import { selectRoots } from '../consumer-graph.mjs';
import { loadInput } from '../consumer-input.mjs';
import { planConsumers } from '../consumer-runner.mjs';
import { startRegistry } from '../quarantine.mjs';
import { addRegistry, cli, workspace } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';

export async function consumerHarness(t, packages, registryPackages = [], prepare = async () => {}, withConsumers = true) {
  const fixture = await workspace(packages);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  for (const name of new Set(registryPackages.map((p) => p.name))) {
    await addRegistry(
      fixture,
      name,
      registryPackages.filter((p) => p.name === name)
    );
  }
  await prepare(fixture);
  const audit = await cli(fixture);
  assert.equal(audit.status, 0, JSON.stringify(audit.report.diagnostics));
  const directory = await mkdtemp(resolve(tmpdir(), 'consumer-fault-'));
  const path = resolve(fixture.output, 'manifest.json');
  const input = await loadInput(
    path,
    hash(await readFile(path)),
    resolve(directory, 'snapshot'),
    await readFile(resolve(fixture.root, 'scripts/release/policy.json'))
  );
  const selection = selectRoots(input, []);
  const state = dockerRun(directory, { consumers: [] });
  t.after(async () => {
    const cleaned = await cleanup(state);
    await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(state.report, null, 2));
    assert(cleaned);
  });
  const images = await provision(state);
  const registry = await startRegistry(state, input, false);
  console.log(`Fault/combined evidence: ${directory}`);
  return { state, input, selection, images, registry, plans: withConsumers ? planConsumers(input, selection) : [], fixture };
}
