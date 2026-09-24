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
  const record = { lastAcceptedSequence: b } as AcceptedBaseline;
  const transport = { initialize: async () => undefined,
    probeRegisteredSource: async () => ({ record, highWatermark: high }),
    loadCoveredThrough: async () => covered } as unknown as MongoProjectionTransportStore;
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
  expect(await poller.pollOnce()).toBe(false);
  expect(await poller.pollOnce()).toBe(true);
  expect(dispatched).toEqual([b + 1, b + 2, b + 3]);
  expect(await poller.pollOnce()).toBe(true);
  expect(dispatched).toHaveLength(3);
});

test('rejects unknown source and indexed retention failure rather than pretending an empty tail', async () => {
  const record = { lastAcceptedSequence: 0 } as AcceptedBaseline;
  const transport = { initialize: async () => undefined, probeRegisteredSource: async () => ({ record, highWatermark: 2 }),
    loadCoveredThrough: async () => null } as unknown as MongoProjectionTransportStore;
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
});
