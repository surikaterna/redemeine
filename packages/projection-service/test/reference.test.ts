import { fixtureRegistry } from '../src/fixtureRegistry';
import { runReference } from '../src/reference/runReference';
import { createReferenceRuntime, waitForModelTurn } from '../src/reference/runtime';
import { firstSource, modelCommit, referenceScenario, secondSource } from '../src/reference/scenario';
import { builtArtifact, referenceConfig } from './fixtures';

test('literal multi-definition registry defaults inline and explicitly opts into own_record', () => {
  expect(fixtureRegistry().map(({ definition }) => definition.deduplication.strategy)).toEqual(['in_document', 'own_record']);
  expect(fixtureRegistry().every(({ definition }) => Object.isFrozen(definition))).toBe(true);
});

test('actual .2 worker/gate/coordinator apply F42 only, all events, fan-in and whole unhandled commit', async () => {
  const commits = referenceScenario();
  const runtime = createReferenceRuntime(await builtArtifact(), referenceConfig, commits);
  await runtime.worker.start(runtime.channel);
  try {
    runtime.channel.deliver();
    await waitForModelTurn(runtime.worker);
    expect(runtime.store.count('model:inline-counter')).toBe(5);
    expect(runtime.store.count('model:own-counter')).toBe(5);
    expect(await runtime.sourceOrder.load(firstSource, runtime.start.epoch)).toMatchObject({ firstSequence: 42, coveredThrough: 42 });
    expect(runtime.reader.requests).toEqual([{ sourceId: firstSource, afterSequence: 41, throughSequence: 42,
      maxCommits: 1, maxBytes: referenceConfig.budget.maxBytes }]);
    for (const _commit of commits.slice(1)) { runtime.channel.deliver(); await waitForModelTurn(runtime.worker); }
    expect(runtime.channel.acknowledgements).toBe(4);
    expect(runtime.store.count('model:inline-counter')).toBe(14);
    expect(runtime.store.count('model:own-counter')).toBe(14);
    expect(await runtime.sourceOrder.load(firstSource, runtime.start.epoch)).toMatchObject({ firstSequence: 42, coveredThrough: 44 });
    expect(await runtime.sourceOrder.load(secondSource, runtime.start.epoch)).toMatchObject({ firstSequence: 7, coveredThrough: 7 });
    expect(runtime.reader.requests.map((r) => r.throughSequence)).toEqual([42, 43, 44, 7]);
    const trace = runtime.trace;
    expect(trace.indexOf('model:floor:42')).toBeLessThan(trace.indexOf('model:fold:model:inline-counter:42'));
    expect(trace.indexOf('model:fold:model:own-counter:42')).toBeLessThan(trace.indexOf('model:coverage:42'));
    expect(trace.indexOf('model:coverage:42')).toBeLessThan(trace.indexOf('model:ack:42'));
  } finally { expect(await runtime.worker.stop()).toEqual({ drained: true }); }
});

test('finite report is explicitly modeled and never production-ready', async () => {
  expect(await runReference(await builtArtifact(), referenceConfig)).toMatchObject({ mode: 'reference',
    productionReady: false, referenceOnly: true, outcome: 'model:completed', firstSequence: 42, coveredThrough: 44,
    acknowledgements: 4, inlineCount: 14, ownRecordCount: 14 });
});

test('permanent whole-commit no-target still completes coverage and ACK without materializing a target', async () => {
  const base = modelCommit(42);
  const runtime = createReferenceRuntime(await builtArtifact(), referenceConfig, [
    { ...base, events: [{ ...base.events[0], payload: { amount: 20, target: 'none' } }] }
  ]);
  await runtime.worker.start(runtime.channel);
  runtime.channel.deliver();
  await waitForModelTurn(runtime.worker);
  expect(runtime.channel.acknowledgements).toBe(1);
  expect(runtime.store.count('model:inline-counter')).toBeNull();
  expect(runtime.store.count('model:own-counter')).toBeNull();
  expect(await runtime.sourceOrder.load(firstSource, runtime.start.epoch)).toMatchObject({ coveredThrough: 42 });
  await runtime.worker.stop();
});

test('coordinator-only gap recovery reads43 not historical prefix, separate from ordered broker scenario', async () => {
  const commits = [modelCommit(42), modelCommit(43), modelCommit(44)];
  const runtime = createReferenceRuntime(await builtArtifact(), referenceConfig, commits);
  await runtime.worker.start(runtime.channel);
  runtime.channel.deliver();
  await waitForModelTurn(runtime.worker);
  const position = await runtime.sourceOrder.load(firstSource, runtime.start.epoch);
  if (!position) throw new Error('missing floor');
  const result = await runtime.coordinator.process(modelCommit(44), position, () => {});
  expect(result).toMatchObject({ status: 'completed', coveredThrough: 44, processedCommits: 2 });
  expect(runtime.reader.requests.map((r) => r.throughSequence)).toEqual([42, 43]);
  expect(runtime.store.count('model:inline-counter')).toBe(3);
  expect(runtime.channel.acknowledgements).toBe(1);
  await runtime.worker.stop();
});

test('partial definition completion cannot advance shared coverage or ACK; coordinator retry deduplicates inline', async () => {
  const runtime = createReferenceRuntime(await builtArtifact(), referenceConfig, [modelCommit(42)]);
  const commit = runtime.store.commitProjectionSourceCommit.bind(runtime.store);
  const failure = jest.spyOn(runtime.store, 'commitProjectionSourceCommit').mockImplementation(async (request) => {
    if (request.projectionName === 'model:own-counter') throw new Error('model:injected_write_failure');
    return commit(request);
  });
  await runtime.worker.start(runtime.channel);
  runtime.channel.deliver();
  await waitForModelTurn(runtime.worker);
  const floor = await runtime.sourceOrder.load(firstSource, runtime.start.epoch);
  expect(floor).toMatchObject({ firstSequence: 42, coveredThrough: null });
  expect(runtime.store.count('model:inline-counter')).toBe(1);
  expect(runtime.store.count('model:own-counter')).toBeNull();
  expect(runtime.channel.acknowledgements).toBe(0);
  failure.mockRestore();
  if (!floor) throw new Error('missing floor');
  expect(await runtime.coordinator.process(modelCommit(42), floor, () => {})).toMatchObject({ status: 'completed', coveredThrough: 42 });
  expect(runtime.store.count('model:inline-counter')).toBe(1);
  expect(runtime.store.count('model:own-counter')).toBe(1);
  expect(runtime.channel.acknowledgements).toBe(0);
  await runtime.worker.stop();
});
