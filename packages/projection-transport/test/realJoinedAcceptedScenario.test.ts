import { expect, test } from '@jest/globals';
import { validateProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { approvalDigest } from '../src';
import { JOINED_AGGREGATE_ID, JOINED_AGGREGATE_TYPE, JOINED_BASELINE, JOINED_GENERATION, JOINED_NAME,
  JOINED_SEQUENCE, JOINED_TARGET, joinedApproval, joinedCollections, joinedDefinition, joinedManifest,
  registerJoinedQueue
} from '../integration/realJoinedAcceptedDefinition';

test('combined joined scenario binds a distinct queue and collections to an approved B>=1 join', () => {
  const queue = 'isolated-db.joined_manual';
  const manifest = joinedManifest(queue);
  const approval = joinedApproval(manifest, 'isolated-db');
  const entry = joinedDefinition();
  expect(validateProjectionQueueRegistryManifest(manifest)).toEqual([]);
  expect(manifest.sourceStartAnchors).toEqual({ '11111111-1111-4111-8111-111111111111': JOINED_SEQUENCE });
  expect(JOINED_BASELINE).toBeGreaterThanOrEqual(1);
  expect(JOINED_SEQUENCE).toBe(JOINED_BASELINE + 1);
  expect(manifest.definitions).toEqual([expect.objectContaining({ projectionName: JOINED_NAME,
    generation: JOINED_GENERATION, joined: true })]);
  expect(entry.definition.deduplication.strategy).toBe('own_record');
  expect(entry.definition.joinStreams?.[0]?.aggregate.aggregateType).toBe(JOINED_AGGREGATE_TYPE);
  const state = { count: 10, seen: [] as number[] };
  entry.definition.joinStreams?.[0]?.handlers.Changed?.(state, {
    aggregateType: JOINED_AGGREGATE_TYPE, aggregateId: JOINED_AGGREGATE_ID, type: 'Changed',
    payload: { amount: 3 }, sequence: 4, timestamp: new Date().toISOString()
  }, {} as never);
  expect(state).toEqual({ count: 13, seen: [3] });
  expect(approval.digest).toBe(approvalDigest(approval));
  expect(approval.inventories[0]?.expected).toEqual([{ aggregateType: JOINED_AGGREGATE_TYPE,
    aggregateId: JOINED_AGGREGATE_ID, targetDocId: JOINED_TARGET }]);
  expect(approval.queueBindingId).toBe(queue);
  expect(new Set(Object.values(joinedCollections)).size).toBe(Object.values(joinedCollections).length);
  expect(approval.inventories[0]?.linkNamespace).toBe(`isolated-db.${joinedCollections.links}`);
  expect(approval.inventories[0]?.documentNamespace).toBe(`isolated-db.${joinedCollections.documents}`);
  expect(approval.approvalNamespace).toBe(`isolated-db.${joinedCollections.approvals}`);
  const cleanupQueues = ['isolated-db.existing'];
  registerJoinedQueue(cleanupQueues, queue);
  expect(cleanupQueues).toEqual(['isolated-db.existing', queue]);
  expect(() => registerJoinedQueue(cleanupQueues, queue)).toThrow('already registered');
});
