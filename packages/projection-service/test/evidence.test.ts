import type { LiveFeedEvidencePort, LiveStartRecord } from '@redemeine/projection-runtime-core';
import { composeRuntime } from '../src/composeRuntime';
import { OrderedFeedModel } from '../src/reference/feedModel';
import { modelScope, modelStart } from '../src/reference/modelIdentity';
import { createReferenceRuntime, waitForModelTurn } from '../src/reference/runtime';
import { firstSource, modelCommit } from '../src/reference/scenario';
import { builtArtifact, referenceConfig } from './fixtures';

test('publisher history cannot checkpoint before intended-route confirm or skip a source commit', async () => {
  const feed = new OrderedFeedModel(modelStart((await builtArtifact()).registryDigest), []);
  feed.publish(modelCommit(42));
  expect(() => feed.persistNativeCheckpoint()).toThrow('model:unconfirmed_checkpoint');
  expect(() => feed.publish(modelCommit(43))).toThrow('model:publication_refused');
  feed.confirmIntendedQueue();
  expect(() => feed.confirmIntendedQueue()).toThrow('model:confirm_refused');
  feed.persistNativeCheckpoint();
  expect(() => feed.append(modelCommit(44))).toThrow('model:noncontiguous_publication');
});

test.each(['registryDigest', 'nativeStartRef', 'sourceScopeDigest', 'publisherRef', 'bindingRef'])('forged start %s cannot open evidence session', async (field) => {
  const start = modelStart((await builtArtifact()).registryDigest);
  const feed = new OrderedFeedModel(start, []);
  feed.append(modelCommit(42));
  const candidate: LiveStartRecord = { ...start, [field]: 'forged' };
  expect(await feed.openSession(candidate, { sessionRef: 'model:test', queueName: start.queueName, prefetch: 1, exclusive: true }))
    .toMatchObject({ status: 'unproven' });
});

test('pending publication is not evidence even when queue confirm already happened', async () => {
  const start = modelStart((await builtArtifact()).registryDigest);
  const feed = new OrderedFeedModel(start, []);
  feed.publish(modelCommit(42));
  feed.confirmIntendedQueue();
  expect(await feed.openSession(start, { sessionRef: 'model:test', queueName: start.queueName, prefetch: 1, exclusive: true }))
    .toMatchObject({ status: 'unproven' });
});

test('session reserves only issued delivery tags and ACK names the original message exactly once', async () => {
  const start = modelStart((await builtArtifact()).registryDigest);
  const feed = new OrderedFeedModel(start, []);
  feed.append(modelCommit(42));
  const result = await feed.openSession(start, { sessionRef: 'model:test', queueName: start.queueName, prefetch: 1, exclusive: true });
  if (result.status !== 'qualified') throw new Error('missing session');
  const raw = feed.issue();
  const identity = { sessionRef: 'model:test', deliveryTag: raw.fields.deliveryTag,
    messageId: modelCommit(42).commitId, redelivered: false };
  expect(() => result.value.reserve({ ...identity, deliveryTag: identity.deliveryTag + 1 })).toThrow('model:unordered_delivery');
  result.value.reserve(identity);
  const first = await result.value.certifyFirst(modelCommit(42), identity);
  expect(first.status).toBe('qualified');
  expect(() => feed.acknowledge({ ...raw })).toThrow('model:ack_refused');
  feed.acknowledge(raw);
  expect(() => feed.acknowledge(raw)).toThrow('model:ack_refused');
  result.value.settled(identity);
  if (first.status !== 'qualified') throw new Error('missing first evidence');
  expect(() => first.value.assertCurrent()).toThrow('model:expired_reservation');
});

test.each(['start', 'sessionRef'])('actual worker rejects mismatched returned session %s identity', async (field) => {
  const artifact = await builtArtifact();
  const runtime = createReferenceRuntime(artifact, referenceConfig, [modelCommit(42)]);
  const evidence: LiveFeedEvidencePort = { async openSession(start, channel) {
    const result = await runtime.evidence.openSession(start, channel);
    if (result.status !== 'qualified') return result;
    const session = result.value;
    return { status: 'qualified', value: {
      start: field === 'start' ? { ...start } : start,
      sessionRef: field === 'sessionRef' ? 'forged' : channel.sessionRef,
      assertCurrent: () => session.assertCurrent(), reserve: (delivery) => session.reserve(delivery),
      certifyFirst: (commit, delivery) => session.certifyFirst(commit, delivery),
      settled: (delivery) => session.settled(delivery), invalidate: () => session.invalidate()
    } };
  } };
  const { worker } = composeRuntime(artifact, runtime.start, modelScope, referenceConfig, { evidence,
    sourceOrder: runtime.sourceOrder, store: runtime.store, reader: runtime.reader });
  await expect(worker.start(runtime.channel)).rejects.toThrow('live_start_unproven');
  expect(await runtime.sourceOrder.load(firstSource, runtime.start.epoch)).toBeNull();
  expect(runtime.channel.acknowledgements).toBe(0);
  expect(runtime.store.count('model:inline-counter')).toBeNull();
  await worker.stop();
});

test('registry mismatch refuses composition before floor or fold', async () => {
  const artifact = await builtArtifact();
  const runtime = createReferenceRuntime(artifact, referenceConfig, [modelCommit(42)]);
  expect(() => composeRuntime(artifact, { ...runtime.start, registryDigest: 'forged' }, modelScope, referenceConfig,
    { evidence: runtime.evidence, sourceOrder: runtime.sourceOrder, store: runtime.store, reader: runtime.reader }))
    .toThrow('artifact_registry_mismatch');
  expect(runtime.trace.some((entry) => /floor|fold|ack:/.test(entry))).toBe(false);
});

test.each(['unknown_redelivery', 'continuity_loss', 'scope_mismatch', 'identity_mismatch'])('%s refuses floor/fold/ACK in actual pipeline', async (fault) => {
  const runtime = createReferenceRuntime(await builtArtifact(), referenceConfig, [modelCommit(42)]);
  if (fault.endsWith('mismatch')) {
    const original = runtime.channel.consume.bind(runtime.channel);
    jest.spyOn(runtime.channel, 'consume').mockImplementation((queue, handler, options) => original(queue, (delivery) => {
      if (!delivery) return handler(delivery);
      handler({ ...delivery, properties: { ...delivery.properties,
        ...(fault === 'scope_mismatch' ? { headers: { ...delivery.properties.headers, partitionId: 'forged' } }
          : { messageId: 'forged' }) } });
    }, options));
  }
  await runtime.worker.start(runtime.channel);
  runtime.channel.deliver(fault === 'unknown_redelivery');
  if (fault === 'continuity_loss') runtime.evidence.loseContinuity();
  await waitForModelTurn(runtime.worker);
  expect(runtime.worker.getStatus().accepting).toBe(false);
  expect(await runtime.sourceOrder.load(firstSource, runtime.start.epoch)).toBeNull();
  expect(runtime.store.count('model:inline-counter')).toBeNull();
  expect(runtime.channel.acknowledgements).toBe(0);
  await runtime.worker.stop();
});

test.each(['invalid', -1, 1.5])('invalid amount %s pauses after admitted floor but before fold/coverage/ACK', async (amount) => {
  const base = modelCommit(42);
  const runtime = createReferenceRuntime(await builtArtifact(), referenceConfig, [
    { ...base, events: [{ ...base.events[0], payload: { amount, target: 'shared' } }] }
  ]);
  await runtime.worker.start(runtime.channel);
  runtime.channel.deliver();
  await waitForModelTurn(runtime.worker);
  expect(await runtime.sourceOrder.load(firstSource, runtime.start.epoch)).toMatchObject({ firstSequence: 42, coveredThrough: null });
  expect(runtime.store.count('model:inline-counter')).toBeNull();
  expect(runtime.channel.acknowledgements).toBe(0);
  await runtime.worker.stop();
});
