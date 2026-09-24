import type { ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import type { ProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { SourceTailPoller } from '../src/sourceTailPoller';
import type { MongoProjectionTransportStore } from '../src/mongoTransportStore';
import type { TapewormMongoRangeReader } from '../src/tapewormMongoRangeReader';
import type { AcceptedBaseline } from '../src/acceptedBaseline';

const sourceId = '00000000-0000-4000-8000-000000000001';
function commit(sequence: number): ProjectionSourceCommit {
  return { streamId: sourceId, commitId: `00000000-0000-4000-8000-${String(sequence + 10).padStart(12, '0')}`,
    commitSequence: sequence, events: [{ eventId: `00000000-0000-4000-8000-${String(sequence + 100).padStart(12, '0')}`,
      eventIndex: 0, streamVersion: sequence, aggregateType: 'Order', aggregateId: 'one', type: 'Changed', payload: {},
      timestamp: '2026-09-24T00:00:00Z' }] };
}

test.each([-1, 0, 4])('configured source B=%s drains without any Rabbit arrival, then polls later rows', async (b) => {
  let high = b;
  let covered: number | null = null;
  const dispatched: number[] = [];
  const record = { lastAcceptedSequence: b, manifestId: 'manifest', queueBindingId: 'orders', sourceId } as AcceptedBaseline;
  const transport = { initialize: async () => undefined,
    readQueueBinding: async () => ({ queueId: 'orders', manifestId: 'manifest' }),
    probeRegisteredSource: async () => ({ record, highWatermark: high }),
    loadCoveredThrough: async () => covered, verifyJoinedCutover: async () => undefined } as unknown as MongoProjectionTransportStore;
  const reader = { initialize: async () => undefined, capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
    readCompleteRange: async (request: { afterSequence: number | null; throughSequence: number; maxCommits: number }) => {
      const next = (request.afterSequence ?? -1) + 1;
      const selected = Array.from({ length: Math.min(request.maxCommits, request.throughSequence - next + 1) }, (_, i) => commit(next + i));
      return { status: 'complete' as const, commits: selected.map((item) => ({ commit: item, encodedByteLength: 100 })),
        encodedByteLength: selected.length * 100, continuationAfterSequence: selected.at(-1)?.commitSequence ?? request.afterSequence,
        hasMore: (selected.at(-1)?.commitSequence ?? request.afterSequence ?? -1) < request.throughSequence };
    } } as TapewormMongoRangeReader;
  const coordinator = { processPolled: async (entry: ProjectionSourceCommit) => {
    dispatched.push(entry.commitSequence); covered = entry.commitSequence;
    return { status: 'completed' as const, processedSequences: [entry.commitSequence], definitions: [] };
  } } as ProjectionCommitCoordinator;
  const poller = new SourceTailPoller({ queueId: 'orders', sourceIds: [sourceId], transport, reader, coordinator,
    intervalMs: 1, maxBytes: 1000, maxCommits: 2, maxPages: 1, maxBootstrapPasses: 4, onFailure: () => undefined });
  await poller.bootstrap();
  expect(dispatched).toEqual([]);
  high = b + 3;
  expect(await poller.pollOnce()).toBe('continuation');
  expect(await poller.pollOnce()).toBe('caught_up');
  expect(dispatched).toEqual([b + 1, b + 2, b + 3]);
  expect(await poller.pollOnce()).toBe('caught_up');
  expect(dispatched).toHaveLength(3);
});

test('rejects unknown source and indexed retention failure rather than pretending an empty tail', async () => {
  const record = { lastAcceptedSequence: 0, manifestId: 'manifest', queueBindingId: 'orders', sourceId } as AcceptedBaseline;
  const transport = { initialize: async () => undefined, probeRegisteredSource: async () => ({ record, highWatermark: 2 }),
    readQueueBinding: async () => ({ queueId: 'orders', manifestId: 'manifest' }),
    loadCoveredThrough: async () => null, verifyJoinedCutover: async () => undefined } as unknown as MongoProjectionTransportStore;
  const reader = { initialize: async () => undefined, readCompleteRange: async (request: { afterSequence: number | null }) =>
    ({ status: 'incomplete', reason: 'history_unavailable', details: 'missing 1', continuationAfterSequence: request.afterSequence })
  } as TapewormMongoRangeReader;
  const poller = new SourceTailPoller({ queueId: 'orders', sourceIds: [sourceId], transport, reader,
    coordinator: {} as ProjectionCommitCoordinator, intervalMs: 10, maxBytes: 1000, maxCommits: 1, maxPages: 2,
    onFailure: () => undefined });
  await expect(poller.bootstrap()).rejects.toThrow('tail unavailable');
  expect(poller.isHealthy()).toBe(false);
  expect(() => new SourceTailPoller({ queueId: 'orders', sourceIds: ['unknown'], transport, reader,
    coordinator: {} as ProjectionCommitCoordinator, intervalMs: 10, maxBytes: 1000, maxCommits: 1, maxPages: 1,
    onFailure: () => undefined })).toThrow('finite explicit UUIDs');
  expect(() => new SourceTailPoller({ queueId: 'orders', sourceIds: [], transport, reader,
    coordinator: {} as ProjectionCommitCoordinator, intervalMs: 10, maxBytes: 1000, maxCommits: 1, maxPages: 1,
    onFailure: () => undefined })).toThrow('finite explicit UUIDs');
});

test('Rabbit notification must match complete indexed source commit, even on covered redelivery', async () => {
  const expected = commit(0);
  const failures: string[] = [];
  let available = true;
  const record = { lastAcceptedSequence: -1, manifestId: 'manifest', queueBindingId: 'orders', sourceId } as AcceptedBaseline;
  const transport = { probeRegisteredSource: async () => ({ record, highWatermark: 0 }) } as MongoProjectionTransportStore;
  const reader = { readCompleteRange: async (request: { afterSequence: number | null }) => available
    ? { status: 'complete' as const, commits: [{ commit: expected, encodedByteLength: 100 }],
      encodedByteLength: 100, continuationAfterSequence: 0, hasMore: false }
    : { status: 'incomplete' as const, reason: 'history_unavailable', details: 'missing',
      continuationAfterSequence: request.afterSequence } } as TapewormMongoRangeReader;
  const poller = new SourceTailPoller({ queueId: 'orders', sourceIds: [sourceId], transport, reader,
    coordinator: {} as ProjectionCommitCoordinator, intervalMs: 10, maxBytes: 1000, maxCommits: 1, maxPages: 1,
    onFailure: (error) => failures.push(error.message) });
  expect(await poller.resolveNotification(expected)).toEqual({ status: 'authoritative', commit: expected });
  await expect(poller.resolveNotification({ ...expected, commitId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }))
    .rejects.toThrow('does not match');
  available = false;
  await expect(poller.resolveNotification(expected)).rejects.toThrow('does not match');
  expect(failures).toHaveLength(2);
});

test.each([0, 4])('B=%s reliable modes suppress pruned pre-B without an indexed historical fetch', async (b) => {
  const old = commit(b === 0 ? 0 : 2);
  const record = { lastAcceptedSequence: b, manifestId: 'manifest', queueBindingId: 'orders', sourceId,
    strategyScope: [{ strategy: 'own_record' }, { strategy: 'in_document' }] } as AcceptedBaseline;
  const transport = { probeRegisteredSource: async () => ({ record, highWatermark: b }) } as MongoProjectionTransportStore;
  const readCompleteRange = jest.fn(async () => { throw new Error('pre-B source was pruned'); });
  const reader = { readCompleteRange } as TapewormMongoRangeReader;
  const poller = new SourceTailPoller({ queueId: 'orders', sourceIds: [sourceId], transport, reader,
    coordinator: {} as ProjectionCommitCoordinator, intervalMs: 10, maxBytes: 1000, maxCommits: 1, maxPages: 1,
    onFailure: () => undefined });
  expect(await poller.resolveNotification(old)).toEqual({ status: 'accepted_baseline', commit: old });
  expect(readCompleteRange).not.toHaveBeenCalled();
});

test.each([0, 4])('B=%s none dispatches only retained validated old commits', async (b) => {
  const old = commit(b === 0 ? 0 : 2);
  const record = { lastAcceptedSequence: b, manifestId: 'manifest', queueBindingId: 'orders', sourceId,
    strategyScope: [{ strategy: 'own_record' }, { strategy: 'none' }] } as AcceptedBaseline;
  const transport = { probeRegisteredSource: async () => ({ record, highWatermark: b }) } as MongoProjectionTransportStore;
  let available = true;
  const reader = { readCompleteRange: async (request: { afterSequence: number | null }) => available
    ? { status: 'complete', commits: [{ commit: old, encodedByteLength: 100 }], encodedByteLength: 100,
      continuationAfterSequence: old.commitSequence, hasMore: false }
    : { status: 'incomplete', reason: 'history_unavailable', details: 'pruned',
      continuationAfterSequence: request.afterSequence } } as TapewormMongoRangeReader;
  const failures: string[] = [];
  const poller = new SourceTailPoller({ queueId: 'orders', sourceIds: [sourceId], transport, reader,
    coordinator: {} as ProjectionCommitCoordinator, intervalMs: 10, maxBytes: 1000, maxCommits: 1, maxPages: 1,
    onFailure: (error) => failures.push(error.message) });
  expect(await poller.resolveNotification(old)).toEqual({ status: 'authoritative', commit: old });
  available = false;
  await expect(poller.resolveNotification(old)).rejects.toThrow('historical_commit_unavailable');
  expect(failures).toEqual(['historical_commit_unavailable']);
});

test.each(['bootstrap', 'page'] as const)('stop joins in-flight %s without dispatch or alert', async (phase) => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const begun = new Promise<void>((resolve) => { entered = resolve; });
  const failures: string[] = [];
  const record = { lastAcceptedSequence: -1, manifestId: 'manifest', queueBindingId: 'orders', sourceId } as AcceptedBaseline;
  const transport = { initialize: async () => undefined, readQueueBinding: async () => ({ queueId: 'orders', manifestId: 'manifest' }),
    probeRegisteredSource: async () => ({ record, highWatermark: 0 }), loadCoveredThrough: async () => null,
    verifyJoinedCutover: async () => undefined } as unknown as MongoProjectionTransportStore;
  const reader = { initialize: async () => { if (phase === 'bootstrap') { entered(); await gate; } },
    readCompleteRange: async () => { if (phase === 'page') { entered(); await gate; }
      return { status: 'complete', commits: [{ commit: commit(0), encodedByteLength: 100 }],
        encodedByteLength: 100, continuationAfterSequence: 0, hasMore: false }; } } as TapewormMongoRangeReader;
  let dispatched = 0;
  const coordinator = { processPolled: async () => { dispatched += 1;
    return { status: 'completed', processedSequences: [0], definitions: [] }; } } as ProjectionCommitCoordinator;
  const poller = new SourceTailPoller({ queueId: 'orders', sourceIds: [sourceId], transport, reader, coordinator,
    intervalMs: 5, maxBytes: 1000, maxCommits: 1, maxPages: 1, onFailure: (error) => failures.push(error.message) });
  const starting = poller.bootstrap();
  await begun;
  const stopping = poller.stop();
  release();
  await expect(starting).rejects.toThrow('stopped');
  await stopping;
  expect(poller.isHealthy()).toBe(false);
  expect(dispatched).toBe(0);
  expect(failures).toEqual([]);
});

test('bounded page continuation is paced, successful and never reported as a failure', async () => {
  const failures: string[] = [];
  const record = { lastAcceptedSequence: -1, manifestId: 'manifest', queueBindingId: 'orders', sourceId } as AcceptedBaseline;
  let covered: number | null = null;
  const transport = { initialize: async () => undefined, readQueueBinding: async () => ({ queueId: 'orders', manifestId: 'manifest' }),
    probeRegisteredSource: async () => ({ record, highWatermark: 1 }), loadCoveredThrough: async () => covered,
    verifyJoinedCutover: async () => undefined } as unknown as MongoProjectionTransportStore;
  const reader = { initialize: async () => undefined, readCompleteRange: async (request: { afterSequence: number | null }) => {
    const sequence = (request.afterSequence ?? -1) + 1;
    return { status: 'complete', commits: [{ commit: commit(sequence), encodedByteLength: 100 }],
      encodedByteLength: 100, continuationAfterSequence: sequence, hasMore: sequence < 1 };
  } } as TapewormMongoRangeReader;
  const coordinator = { processPolled: async (entry: ProjectionSourceCommit) => { covered = entry.commitSequence;
    return { status: 'completed', processedSequences: [entry.commitSequence], definitions: [] }; } } as ProjectionCommitCoordinator;
  const poller = new SourceTailPoller({ queueId: 'orders', sourceIds: [sourceId], transport, reader, coordinator,
    intervalMs: 1, maxBytes: 1000, maxCommits: 1, maxPages: 1, maxBootstrapPasses: 3,
    onFailure: (error) => failures.push(error.message) });
  await poller.bootstrap();
  expect(failures).toEqual([]);
  expect(covered).toBe(1);
  expect(poller.isHealthy()).toBe(true);
  await poller.stop();
});
