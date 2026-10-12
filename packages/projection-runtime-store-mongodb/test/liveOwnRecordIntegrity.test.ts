import { describe, expect, jest, test } from '@jest/globals';
import { createLiveCommitCoordinator } from '../../projection-worker-core/src/liveCommitCoordinator';
import { floor, liveCommit, liveDefinition, MemoryLiveOrder } from '../../projection-worker-core/test/liveFixtures';
import { createLiveDeliveryGate } from '../../projection-transport/src/liveDeliveryGate';
import { LiveProjectionRabbitWorker } from '../../projection-transport/src/liveRabbitWorker';
import { delivery, LiveChannelFixture, readerFor, waitFor } from '../../projection-transport/test/liveRabbitFixtures';
import { liveStart, OrderedLiveFeedFixture } from '../../projection-transport/test/orderedLiveFeedFixture';
import { MongoProjectionStore } from '../src';
import { createFakeMongoClient, createProjectionDedupeCollection, createProjectionDocumentCollection, createProjectionLinkCollection } from './mocks';

const invalidSequences = [Infinity, 42.5, '42', NaN, -1, -Infinity, Number.MAX_SAFE_INTEGER + 1, true, false];

async function fixture() {
  const commit = liveCommit(42);
  const position = floor(commit);
  const sourceOrder = new MemoryLiveOrder();
  const dedupe = createProjectionDedupeCollection();
  const documents = createProjectionDocumentCollection<{ count: number }>();
  const store = new MongoProjectionStore({ collection: documents, dedupeCollection: dedupe,
    linkCollection: createProjectionLinkCollection(), mongoClient: createFakeMongoClient() });
  await store.initializeProjectionSourceCommitStore();
  const persist = jest.spyOn(store, 'commitProjectionSourceCommit');
  const read = jest.spyOn(store, 'loadProjectionSourceCommitSnapshot');
  const reader = readerFor([commit, liveCommit(43)]);
  const coordinator = createLiveCommitCoordinator({ epoch: 'epoch', registryDigest: 'registry',
    definitions: [{ definition: liveDefinition('counter', 'own_record'), generation: 'generation' }],
    store, sourceOrder, rangeReader: reader,
    budget: { maxCommits: 1, maxBytes: 10000, maxMilliseconds: 1000, maxEventsPerCommit: 20 } });
  const seed = async (commitSequence: unknown) => {
    await dedupe.updateOne({ _id: `counter\u0000generation\u0000${commit.streamId}` },
      { $set: { commitSequence } }, { upsert: true });
    dedupe.operationLog.length = 0;
  };
  return { commit, position, sourceOrder, dedupe, documents, persist, read, coordinator, reader, seed };
}

describe('live own_record integrity through actual Mongo snapshot loading', () => {
  test.each(invalidSequences)('coordinator pauses on persisted %p without writes or coverage', async (sequence) => {
    const f = await fixture();
    f.sourceOrder.positions.set(f.commit.streamId, f.position);
    await f.seed(sequence);
    expect(await f.coordinator.process(f.commit, f.position, () => {})).toEqual({ status: 'paused', processedCommits: 0,
      coveredThrough: null, reason: 'marker_lifetime_violation' });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect((await f.read.mock.results[0]?.value).ownRecordSequence).toBe(sequence);
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.documents.snapshot()).toEqual([]);
    expect(f.dedupe.snapshot()[0]?.commitSequence).toBe(sequence);
    expect(f.dedupe.operationLog.every(({ op }) => op === 'findOne')).toBe(true);
    expect(f.sourceOrder.positions.get(f.commit.streamId)).toEqual(f.position);
  });

  test.each(invalidSequences)('full worker never ACKs persisted %p with a missing target', async (sequence) => {
    const f = await fixture();
    await f.seed(sequence);
    const feed = new OrderedLiveFeedFixture();
    feed.append(f.commit);
    const channel = new LiveChannelFixture();
    const worker = new LiveProjectionRabbitWorker({ start: liveStart, evidence: feed, sourceOrder: f.sourceOrder,
      coordinator: f.coordinator, gate: createLiveDeliveryGate({ sourceScopeDigest: 'scope', collection: 'commits',
        partitionId: 'partition' }, f.reader, 10000), continuationDelayMs: 5, shutdownTimeoutMs: 100 });
    try {
      await worker.start(channel);
      channel.handler?.(delivery(feed, f.commit));
      await waitFor(() => !worker.getStatus().accepting);
      expect(worker.getStatus().reason).toBe('live_coordinator_paused');
      expect(channel.ack).not.toHaveBeenCalled();
      expect(f.persist).not.toHaveBeenCalled();
      expect(f.documents.snapshot()).toEqual([]);
      expect(f.dedupe.snapshot()[0]?.commitSequence).toBe(sequence);
      expect(f.dedupe.operationLog.every(({ op }) => op === 'findOne')).toBe(true);
      expect(f.sourceOrder.positions.get(f.commit.streamId)).toEqual(f.position);
    } finally { await worker.stop(); }
  });

  test.each(invalidSequences)('conflict retry revalidates %p introduced after the initial valid snapshot', async (sequence) => {
    const f = await fixture();
    f.sourceOrder.positions.set(f.commit.streamId, f.position);
    f.persist.mockImplementationOnce(async () => {
      await f.seed(sequence);
      return { version: 1, status: 'rejected', category: 'conflict', retryable: true, reason: 'injected OCC conflict' };
    });
    expect(await f.coordinator.process(f.commit, f.position, () => {})).toEqual({ status: 'paused', processedCommits: 0,
      coveredThrough: null, reason: 'marker_lifetime_violation' });
    expect(f.read).toHaveBeenCalledTimes(3);
    const snapshots = await Promise.all(f.read.mock.results.map((result) => result.value));
    expect(snapshots.map((snapshot) => snapshot.ownRecordSequence)).toEqual([null, null, sequence]);
    expect(f.persist).toHaveBeenCalledTimes(1);
    expect(f.documents.snapshot()).toEqual([]);
    expect(f.dedupe.snapshot()[0]?.commitSequence).toBe(sequence);
    expect(f.dedupe.operationLog.every(({ op }) => op === 'findOne')).toBe(true);
    expect(f.sourceOrder.positions.get(f.commit.streamId)).toEqual(f.position);
  });

  test('corruption after valid F42 preserves existing coverage and target on the next delivery', async () => {
    const f = await fixture();
    f.sourceOrder.positions.set(f.commit.streamId, f.position);
    expect((await f.coordinator.process(f.commit, f.position, () => {})).status).toBe('completed');
    const documents = structuredClone(f.documents.snapshot());
    const covered = f.sourceOrder.positions.get(f.commit.streamId);
    await f.seed(Infinity);
    f.persist.mockClear();
    expect(await f.coordinator.process(liveCommit(43), f.position, () => {})).toEqual({ status: 'paused', processedCommits: 0,
      coveredThrough: 42, reason: 'marker_lifetime_violation' });
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.documents.snapshot()).toEqual(documents);
    expect(f.sourceOrder.positions.get(f.commit.streamId)).toEqual(covered);
  });
});
