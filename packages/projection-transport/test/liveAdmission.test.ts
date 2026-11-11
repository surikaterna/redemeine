import { describe, expect, test } from '@jest/globals';
import type { LiveFeedSession } from '@redemeine/projection-runtime-core';
import { liveCommit, liveDefinition, MemoryLiveOrder } from '../../projection-worker-core/test/liveFixtures';
import { admitLiveDelivery } from '../src/liveAdmissionEvidence';
import { normalizeLiveRegistration, validateLiveStart } from '../src/liveRegistration';
import { liveStart, OrderedLiveFeedFixture } from './orderedLiveFeedFixture';

async function open(feed: OrderedLiveFeedFixture, sessionRef = 'channel-1'): Promise<LiveFeedSession> {
  const result = await feed.openSession(liveStart, { sessionRef, queueName: liveStart.queueName, prefetch: 1, exclusive: true });
  if (result.status !== 'qualified') throw new Error(result.reason);
  return result.value;
}

describe('modeled live admission', () => {
  test('serial confirmed/checkpointed feed certifies F42 and persists null coverage before folding', async () => {
    const feed = new OrderedLiveFeedFixture();
    const commit = liveCommit(42);
    feed.append(commit);
    const session = await open(feed);
    const delivery = feed.delivery();
    session.reserve(delivery);
    const order = new MemoryLiveOrder();
    expect(await admitLiveDelivery(order, session, commit, delivery)).toEqual({ epoch: 'epoch', registryDigest: 'registry',
      sourceId: commit.streamId, firstSequence: 42, firstCommitId: commit.commitId, coveredThrough: null });
    expect(order.loads).toBe(1);
  });

  test('unknown redelivery refuses, known floor restart works and stale evidence expires', async () => {
    const feed = new OrderedLiveFeedFixture();
    const commit = liveCommit(42);
    feed.append(commit);
    const session = await open(feed);
    const delivery = feed.delivery();
    session.reserve(delivery);
    const witness = await session.certifyFirst(commit, delivery);
    session.invalidate();
    if (witness.status !== 'qualified') throw new Error('fixture failed');
    expect(() => witness.value.assertCurrent()).toThrow('expired');
    const resumed = await open(feed, 'channel-2');
    const redelivery = feed.delivery(true);
    resumed.reserve(redelivery);
    const order = new MemoryLiveOrder();
    await expect(admitLiveDelivery(order, resumed, commit, redelivery)).rejects.toThrow('unproven');
    order.positions.set(commit.streamId, witness.value.position);
    await expect(admitLiveDelivery(order, resumed, commit, redelivery)).resolves.toEqual(witness.value.position);
  });

  test('first admission cannot be obtained from later payload or invented delivery tag', async () => {
    const feed = new OrderedLiveFeedFixture();
    feed.append(liveCommit(42));
    feed.append(liveCommit(43));
    const session = await open(feed);
    const delivery = feed.delivery();
    expect(() => session.reserve({ ...delivery, deliveryTag: 9 })).toThrow('unordered');
    session.reserve(delivery);
    expect((await session.certifyFirst(liveCommit(43), delivery)).status).toBe('unproven');
    expect(() => session.reserve(delivery)).toThrow('unordered');
  });

  test('missing checkpoint, altered epoch and competing consumer cannot qualify', async () => {
    const feed = new OrderedLiveFeedFixture();
    feed.publish(liveCommit(42));
    feed.confirmIntendedQueue();
    await expect(open(feed)).rejects.toThrow('unproven');
    feed.persistNativeCheckpoint();
    expect((await feed.openSession({ ...liveStart, epoch: 'other' }, {
      sessionRef: 'c', queueName: liveStart.queueName, prefetch: 1, exclusive: true })).status).toBe('unproven');
    await open(feed);
    await expect(open(feed, 'competitor')).rejects.toThrow('unproven');
  });

  test('normalization is private inline default, explicit override preserved, history refused', () => {
    const definition = liveDefinition();
    const { deduplication: _deduplication, ...omitted } = definition;
    const registration = { definition: omitted, initialization: 'suffix_contributions' as const, routing: 'event_stable_commutative' as const };
    expect(normalizeLiveRegistration(registration).deduplication).toEqual({ strategy: 'in_document' });
    expect(normalizeLiveRegistration({ ...registration, definition: liveDefinition('own', 'own_record') }).deduplication.strategy).toBe('own_record');
    expect(() => normalizeLiveRegistration({ ...registration, initialization: 'history_dependent' })).toThrow('initialization');
    expect(() => normalizeLiveRegistration({ ...registration, routing: 'dynamic' })).toThrow('routing');
    expect(() => validateLiveStart({ ...liveStart, nativeStartRef: '' })).toThrow('unproven');
    const missing = { ...liveStart };
    Reflect.deleteProperty(missing, 'nativeStartRef');
    expect(() => validateLiveStart(missing)).toThrow('unproven');
    for (const field of ['joinStreams', 'reverseSubscribeStreams'] as const) {
      expect(() => normalizeLiveRegistration({ ...registration, definition: { ...omitted,
        [field]: [{ aggregate: { aggregateType: 'Other' }, handlers: {} }] } })).toThrow('routing');
    }
  });

  test('a witness altered after certification cannot create a floor', async () => {
    const feed = new OrderedLiveFeedFixture();
    const commit = liveCommit(42);
    feed.append(commit);
    const session = await open(feed);
    const delivery = feed.delivery();
    session.reserve(delivery);
    const result = await session.certifyFirst(commit, delivery);
    if (result.status !== 'qualified') throw new Error('fixture');
    const order = new MemoryLiveOrder();
    const mismatched: LiveFeedSession = { ...session, certifyFirst: async () => ({ status: 'qualified', value: {
      ...result.value, position: { ...result.value.position, firstCommitId: liveCommit(43).commitId }
    } }) };
    await expect(admitLiveDelivery(order, mismatched, commit, delivery)).rejects.toThrow('mismatched_first');
    expect(order.positions.size).toBe(0);
  });
});
