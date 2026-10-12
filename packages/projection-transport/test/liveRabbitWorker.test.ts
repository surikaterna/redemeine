import { describe, expect, jest, test } from '@jest/globals';
import type { LiveCommitCoordinator } from '@redemeine/projection-runtime-core';
import { createLiveCommitCoordinator } from '../../projection-worker-core/src/liveCommitCoordinator';
import { liveCommit, liveDefinition, LiveCounterStore, MemoryLiveOrder } from '../../projection-worker-core/test/liveFixtures';
import { createLiveDeliveryGate, type LiveDeliveryGate } from '../src/liveDeliveryGate';
import { LiveProjectionRabbitWorker } from '../src/liveRabbitWorker';
import { liveStart, OrderedLiveFeedFixture } from './orderedLiveFeedFixture';
import { delivery, LiveChannelFixture, readerFor, waitFor } from './liveRabbitFixtures';

function fixture(gateOverride?: (gate: LiveDeliveryGate) => LiveDeliveryGate, coordinatorOverride?: LiveCommitCoordinator) {
  const commits = [liveCommit(42), liveCommit(43), liveCommit(44)];
  const feed = new OrderedLiveFeedFixture();
  commits.forEach((commit) => feed.append(commit));
  const channel = new LiveChannelFixture();
  const sourceOrder = new MemoryLiveOrder();
  const store = new LiveCounterStore();
  const reader = readerFor(commits);
  const gate = createLiveDeliveryGate({ sourceScopeDigest: 'scope', collection: 'commits', partitionId: 'partition' }, reader, 10000);
  const coordinator = createLiveCommitCoordinator({ epoch: 'epoch', registryDigest: 'registry', definitions: [
    { definition: liveDefinition('a'), generation: 'generation' }, { definition: liveDefinition('b'), generation: 'generation' }
  ], store, sourceOrder, rangeReader: reader, budget: { maxCommits: 1, maxBytes: 10000, maxMilliseconds: 1000, maxEventsPerCommit: 20 } });
  const worker = new LiveProjectionRabbitWorker({ start: liveStart, evidence: feed, sourceOrder, coordinator: coordinatorOverride ?? coordinator,
    gate: gateOverride?.(gate) ?? gate, continuationDelayMs: 5, shutdownTimeoutMs: 10 });
  return { commits, feed, channel, sourceOrder, store, worker };
}

describe('additive live Rabbit worker', () => {
  test('floor with null coverage is durable before either definition writes', async () => {
    const f = fixture();
    const persist = f.store.commitProjectionSourceCommit.bind(f.store);
    const writes = jest.spyOn(f.store, 'commitProjectionSourceCommit').mockImplementation(async (request) => {
      expect(f.sourceOrder.positions.get(request.commit.streamId)).toMatchObject({ firstSequence: 42,
        firstCommitId: request.commit.commitId, coveredThrough: null });
      return persist(request);
    });
    await f.worker.start(f.channel);
    f.channel.handler?.(delivery(f.feed, f.commits[0]!));
    await waitFor(() => f.channel.ack.mock.calls.length === 1);
    expect(writes).toHaveBeenCalledTimes(2);
    await f.worker.stop();
  });

  test.each(['expireNativeResume', 'loseQueue'] as const)('%s refuses fresh-now reset on restart', async (fault) => {
    const f = fixture();
    f.feed[fault]();
    await expect(f.worker.start(f.channel)).rejects.toThrow('live_start_unproven');
    expect(f.channel.consume).not.toHaveBeenCalled();
    expect(f.store.writes).toEqual([]);
    expect(f.sourceOrder.positions.size).toBe(0);
    await f.worker.stop();
  });

  test('continuation holds original delivery and one slot unACKed across paced turns', async () => {
    let turns = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    const f = fixture(undefined, { epoch: 'epoch', registryDigest: 'registry', generation: 'generation', async process(commit) {
      seen.push(commit.commitId);
      turns += 1;
      if (turns === 1) return { status: 'continuation', processedCommits: 1, coveredThrough: null };
      await barrier;
      return { status: 'completed', processedCommits: 1, coveredThrough: 42 };
    } });
    await f.worker.start(f.channel);
    f.channel.handler?.(delivery(f.feed, f.commits[0]!));
    await waitFor(() => turns === 2);
    expect(f.worker.getStatus().activeDeliveries).toBe(1);
    expect(f.channel.ack).not.toHaveBeenCalled();
    release?.();
    await waitFor(() => f.channel.ack.mock.calls.length === 1);
    expect(seen).toEqual([f.commits[0]!.commitId, f.commits[0]!.commitId]);
    await f.worker.stop();
  });

  test('uncertain ACK pauses; channel is closed without terminal drop', async () => {
    const f = fixture();
    f.channel.ack.mockImplementation(() => { throw new Error('channel failed'); });
    await f.worker.start(f.channel);
    f.channel.handler?.(delivery(f.feed, f.commits[0]!));
    await waitFor(() => !f.worker.getStatus().accepting);
    expect(f.channel.ack).toHaveBeenCalledTimes(1);
    expect(f.sourceOrder.positions.get(f.commits[0]!.streamId)?.coveredThrough).toBe(42);
    await f.worker.stop();
    expect(f.channel.close).toHaveBeenCalledTimes(1);
  });

  test('unsettled channel close prevents reconnect even when no database turn is active', async () => {
    const f = fixture();
    await f.worker.start(f.channel);
    f.channel.close.mockImplementation(() => new Promise(() => {}));
    expect(await f.worker.stop()).toEqual({ drained: false });
    await expect(f.worker.start(new LiveChannelFixture())).rejects.toThrow('not_drained');
  });

  test('exact queue, exclusive prefetch1, ACK only after both definitions and coverage', async () => {
    const f = fixture();
    await f.worker.start(f.channel);
    expect(f.channel.prefetch).toHaveBeenCalledWith(1);
    expect(f.channel.consume).toHaveBeenCalledWith('rdm.projection.commits', expect.any(Function), { noAck: false, exclusive: true });
    const message = delivery(f.feed, f.commits[0]!);
    f.channel.handler?.(message);
    expect(f.worker.getStatus().activeDeliveries).toBe(1);
    expect(f.channel.ack).not.toHaveBeenCalled();
    await waitFor(() => f.channel.ack.mock.calls.length === 1);
    expect(f.store.targets.get('a:shared')?.state).toEqual({ count: 1 });
    expect(f.store.targets.get('b:shared')?.state).toEqual({ count: 1 });
    expect(f.sourceOrder.positions.get(f.commits[0]!.streamId)?.coveredThrough).toBe(42);
    expect(await f.worker.stop()).toEqual({ drained: true });
  });

  test('reserves callback before first await; second callback invalidates first before admission', async () => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture((gate) => ({ ...gate, async verify(message) { await barrier; return gate.verify(message); } }));
    await f.worker.start(f.channel);
    const message = delivery(f.feed, f.commits[0]!);
    f.channel.handler?.(message);
    f.channel.handler?.(message);
    release?.();
    await waitFor(() => f.worker.getStatus().activeDeliveries === 0);
    expect(f.worker.getStatus()).toMatchObject({ accepting: false, reason: 'live_delivery_overlap' });
    expect(f.sourceOrder.positions.size).toBe(0);
    expect(f.store.writes).toEqual([]);
    expect(f.channel.ack).not.toHaveBeenCalled();
    await f.worker.stop();
  });

  test('partial failure is unACKed; known-floor redelivery resumes both definitions via markers', async () => {
    const f = fixture();
    f.store.failDefinition = 'b';
    await f.worker.start(f.channel);
    f.channel.handler?.(delivery(f.feed, f.commits[0]!));
    await waitFor(() => !f.worker.getStatus().accepting);
    expect(f.channel.ack).not.toHaveBeenCalled();
    expect(f.sourceOrder.positions.get(f.commits[0]!.streamId)?.coveredThrough).toBeNull();
    await f.worker.stop();
    f.store.failDefinition = undefined;
    const next = new LiveChannelFixture();
    await f.worker.start(next);
    next.handler?.(delivery(f.feed, f.commits[0]!, true));
    await waitFor(() => next.ack.mock.calls.length === 1);
    expect(f.store.targets.get('a:shared')?.state).toEqual({ count: 1 });
    expect(f.store.targets.get('b:shared')?.state).toEqual({ count: 1 });
    await f.worker.stop();
  });

  test('unknown redelivery cannot infer F from authoritative row', async () => {
    const f = fixture();
    await f.worker.start(f.channel);
    f.channel.handler?.(delivery(f.feed, f.commits[0]!, true));
    await waitFor(() => !f.worker.getStatus().accepting);
    expect(f.sourceOrder.positions.size).toBe(0);
    expect(f.store.writes).toEqual([]);
    expect(f.channel.ack).not.toHaveBeenCalled();
    await f.worker.stop();
  });

  test.each(['close', 'error', 'cancel', 'stop'])('%s invalidates old evidence and cannot ACK across reconnect', async (event) => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture((gate) => ({ ...gate, async verify(message) { await barrier; return gate.verify(message); } }));
    await f.worker.start(f.channel);
    const oldCallback = f.channel.handler;
    const message = delivery(f.feed, f.commits[0]!);
    oldCallback?.(message);
    await Promise.resolve();
    if (event === 'cancel') oldCallback?.(null);
    else if (event !== 'stop') f.channel.emit(event);
    expect(await f.worker.stop()).toEqual({ drained: false });
    await expect(f.worker.start(new LiveChannelFixture())).rejects.toThrow('not_drained');
    release?.();
    await waitFor(() => f.worker.getStatus().activeDeliveries === 0);
    const next = new LiveChannelFixture();
    await f.worker.start(next);
    oldCallback?.(message);
    expect(next.ack).not.toHaveBeenCalled();
    expect(f.channel.ack).not.toHaveBeenCalled();
    expect(f.store.writes).toEqual([]);
    await f.worker.stop();
  });
});
