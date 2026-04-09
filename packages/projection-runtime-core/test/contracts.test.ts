import { describe, expect, test } from 'bun:test';
import type {
  Checkpoint,
  ProjectionIngress,
  ProjectionIngressDecision,
  ProjectionIngressEnvelope,
  ProjectionIngressPushManyResult,
  ProjectionIngressPushResult,
  ProjectionStoreAtomicManyContract,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest,
  ProjectionStoreContract,
  ProjectionStoreDocumentWrite,
  ProjectionStoreDurableDedupeContract,
  ProjectionShardCheckpointLeaseContract,
  ProjectionShardCheckpointLeaseState,
  ProjectionShardCheckpointCommitResult,
  ProjectionShardLeaseClaimResult,
  ProjectionShardLeaseRebalancePlan,
  ProjectionShardLeaseRenewResult,
  ProjectionShardOwnerIdentity,
  ProjectionRouterFanoutEnvelope,
  ProjectionStoreWriteWatermark
} from '../src';

function isAck(decision: ProjectionIngressDecision): boolean {
  return decision.status === 'ack';
}

function ownerKey(owner: ProjectionShardOwnerIdentity): string {
  return `${owner.workerId}:${owner.workerEpoch ?? ''}`;
}

function createLeaseFixture(
  owner: ProjectionShardOwnerIdentity,
  checkpoint: Checkpoint = { sequence: 0 },
  leaseVersion = 1,
  timeline = {
    acquiredAt: '2026-04-09T18:00:00.000Z',
    renewBy: '2026-04-09T18:00:20.000Z',
    expiresAt: '2026-04-09T18:00:30.000Z'
  }
): ProjectionShardCheckpointLeaseState {
  return {
    shardId: 'shard-1',
    status: 'active',
    lease: {
      shardId: 'shard-1',
      owner,
      leaseVersion
    },
    checkpoint,
    timeline,
    updatedAt: timeline.acquiredAt
  };
}

function createInMemoryLeaseContract(initialState: ProjectionShardCheckpointLeaseState): ProjectionShardCheckpointLeaseContract {
  let state = initialState;

  return {
    async claimLease(request): Promise<ProjectionShardLeaseClaimResult> {
      const activeLease = state.lease;
      const isActive = state.status === 'active' && activeLease !== null;
      const expired = Boolean(state.timeline && request.at >= state.timeline.expiresAt);

      if (isActive && !expired) {
        return { status: 'rejected', state, reason: 'not-expired' };
      }

      if (
        typeof request.expectedPreviousLeaseVersion === 'number'
        && activeLease
        && request.expectedPreviousLeaseVersion !== activeLease.leaseVersion
      ) {
        return { status: 'rejected', state, reason: 'stale-observation' };
      }

      const nextVersion = (activeLease?.leaseVersion ?? 0) + 1;
      state = {
        ...state,
        status: 'active',
        lease: {
          shardId: request.shardId,
          owner: request.contender,
          leaseVersion: nextVersion
        },
        timeline: {
          acquiredAt: request.at,
          renewBy: request.at,
          expiresAt: '2026-04-09T18:02:00.000Z'
        },
        updatedAt: request.at
      };

      return { status: 'claimed', state };
    },

    async renewLease(request): Promise<ProjectionShardLeaseRenewResult> {
      const activeLease = state.lease;
      if (state.status !== 'active' || !activeLease) {
        return { status: 'rejected', state, reason: 'not-active' };
      }

      if (ownerKey(activeLease.owner) !== ownerKey(request.owner)) {
        return { status: 'rejected', state, reason: 'owner-mismatch' };
      }

      if (activeLease.leaseVersion !== request.leaseVersion) {
        return { status: 'rejected', state, reason: 'stale-lease' };
      }

      state = {
        ...state,
        timeline: state.timeline
          ? { ...state.timeline, renewBy: request.at }
          : undefined,
        updatedAt: request.at
      };

      return { status: 'renewed', state };
    },

    async commitCheckpoint(request): Promise<ProjectionShardCheckpointCommitResult> {
      const activeLease = state.lease;
      if (state.status !== 'active' || !activeLease) {
        return { status: 'rejected', state, reason: 'not-active' };
      }

      if (ownerKey(activeLease.owner) !== ownerKey(request.owner)) {
        return { status: 'rejected', state, reason: 'owner-mismatch' };
      }

      if (activeLease.leaseVersion !== request.leaseVersion) {
        return { status: 'rejected', state, reason: 'stale-lease' };
      }

      if (request.checkpoint.sequence < state.checkpoint.sequence) {
        return { status: 'rejected', state, reason: 'checkpoint-regression' };
      }

      state = {
        ...state,
        checkpoint: request.checkpoint,
        updatedAt: request.committedAt
      };

      return { status: 'committed', state };
    },

    async readShardState(shardId): Promise<ProjectionShardCheckpointLeaseState | null> {
      return state.shardId === shardId ? state : null;
    }
  };
}

describe('projection-runtime-core contract types', () => {
  test('push and pushMany contracts return per-item decisions', async () => {
    const ingress: ProjectionIngress = {
      async push(envelope: ProjectionIngressEnvelope): Promise<ProjectionIngressPushResult> {
        return {
          item: {
            messageId: envelope.metadata.messageId,
            decision: { status: 'ack' }
          }
        };
      },
      async pushMany(envelopes: readonly ProjectionIngressEnvelope[]): Promise<ProjectionIngressPushManyResult> {
        return {
          items: envelopes.map((envelope) => ({
            messageId: envelope.metadata.messageId,
            decision: envelope.metadata.retryCount > 0
              ? { status: 'nack', retryable: true, reason: 'retry-once' }
              : { status: 'ack' }
          }))
        };
      }
    };

    const envelope: ProjectionIngressEnvelope = {
      event: {
        aggregateType: 'invoice',
        aggregateId: 'invoice-1',
        type: 'created',
        payload: { amount: 42 },
        sequence: 10,
        timestamp: '2026-04-09T18:00:00.000Z'
      },
      metadata: {
        messageId: 'msg-1',
        priority: 'high',
        retryCount: 0,
        resume: { token: 'r-1' }
      }
    };

    const single = await ingress.push(envelope);
    expect(single.item.messageId).toBe('msg-1');
    expect(isAck(single.item.decision)).toBe(true);

    const many = await ingress.pushMany([
      envelope,
      {
        ...envelope,
        metadata: {
          ...envelope.metadata,
          messageId: 'msg-2',
          retryCount: 1
        }
      }
    ]);

    expect(many.items).toHaveLength(2);
    expect(many.items[0].decision.status).toBe('ack');
    expect(many.items[1].decision).toEqual({
      status: 'nack',
      retryable: true,
      reason: 'retry-once'
    });
  });

  test('router fanout and atomicMany contracts include locked fields', () => {
    const fanout: ProjectionRouterFanoutEnvelope = {
      routingKey: {
        projectionName: 'invoice-summary',
        targetDocId: 'doc-1'
      },
      routingKeySource: 'invoice-summary:doc-1',
      envelope: {
        event: {
          aggregateType: 'invoice',
          aggregateId: 'invoice-1',
          type: 'created',
          payload: {},
          sequence: 11,
          timestamp: '2026-04-09T18:00:01.000Z'
        },
        metadata: {
          messageId: 'msg-3',
          priority: 'normal',
          retryCount: 0
        }
      }
    };

    const atomic: ProjectionStoreAtomicManyResult = {
      status: 'committed',
      highestWatermark: { sequence: 11, timestamp: '2026-04-09T18:00:01.000Z' },
      byLaneWatermark: {
        'invoice-summary:doc-1': { sequence: 11 }
      },
      committedCount: 1
    };

    const writeWatermark: ProjectionStoreWriteWatermark = {
      checkpoint: { sequence: 11 }
    };

    expect(fanout.routingKeySource).toBe('invoice-summary:doc-1');
    expect(atomic.status).toBe('committed');
    expect(atomic.highestWatermark.sequence).toBe(11);
    expect(atomic.byLaneWatermark?.['invoice-summary:doc-1']?.sequence).toBe(11);
    expect(writeWatermark.checkpoint.sequence).toBe(11);
  });

  test('store document write contract discriminates full and patch writes', () => {
    const fullWrite: ProjectionStoreDocumentWrite<{ total: number }> = {
      documentId: 'doc-1',
      mode: 'full',
      fullDocument: { total: 11 },
      checkpoint: { sequence: 11 }
    };

    const patchWrite: ProjectionStoreDocumentWrite = {
      documentId: 'doc-1',
      mode: 'patch',
      patch: { total: 12 },
      checkpoint: { sequence: 12 }
    };

    expect(fullWrite.mode).toBe('full');
    if (fullWrite.mode === 'full') {
      expect(fullWrite.fullDocument.total).toBe(11);
    }

    expect(patchWrite.mode).toBe('patch');
    if (patchWrite.mode === 'patch') {
      expect(patchWrite.patch.total).toBe(12);
    }
  });

  test('store atomicMany contract exposes highest watermark and durable dedupe semantics', async () => {
    const dedupeStore: ProjectionStoreDurableDedupeContract = {
      async getDedupeCheckpoint(key) {
        return key === 'invoice:1:created:11' ? { sequence: 11 } : null;
      }
    };

    const atomicManyOnly: ProjectionStoreAtomicManyContract = {
      async commitAtomicMany(request: ProjectionStoreCommitAtomicManyRequest): Promise<ProjectionStoreAtomicManyResult> {
        if (request.writes.length === 0) {
          return {
            status: 'rejected',
            highestWatermark: null,
            failedAtIndex: 0,
            reason: 'no writes',
            committedCount: 0
          };
        }

        return {
          status: 'committed',
          highestWatermark: { sequence: 21 },
          byLaneWatermark: {
            [request.writes[0]?.routingKeySource ?? 'unknown:unknown']: { sequence: 21 }
          },
          committedCount: request.writes.length
        };
      }
    };

    const store: ProjectionStoreContract = {
      ...atomicManyOnly,
      ...dedupeStore
    };

    const rejected = await store.commitAtomicMany({ mode: 'atomic-all', writes: [] });
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') {
      expect(rejected.highestWatermark).toBeNull();
      expect(rejected.committedCount).toBe(0);
      expect(rejected.failedAtIndex).toBe(0);
    }

    const committed = await store.commitAtomicMany({
      mode: 'atomic-all',
      writes: [
        {
          routingKeySource: 'invoice-summary:doc-1',
          documents: [
            {
              documentId: 'doc-1',
              mode: 'patch',
              patch: { total: 21 },
              checkpoint: { sequence: 21 }
            }
          ],
          dedupe: {
            upserts: [{ key: 'invoice:1:created:21', checkpoint: { sequence: 21 } }]
          }
        }
      ]
    });

    expect(committed.status).toBe('committed');
    if (committed.status === 'committed') {
      expect(committed.highestWatermark.sequence).toBe(21);
      expect(committed.committedCount).toBe(1);
      expect(committed.byLaneWatermark?.['invoice-summary:doc-1']?.sequence).toBe(21);
    }

    const dedupeCheckpoint = await store.getDedupeCheckpoint('invoice:1:created:11');
    expect(dedupeCheckpoint?.sequence).toBe(11);
  });

  test('checkpoint lease contract encodes claim, renew, expiry takeover, and monotonic checkpoint commit', async () => {
    const ownerA = { workerId: 'worker-a', workerEpoch: 'epoch-1' };
    const ownerB = { workerId: 'worker-b', workerEpoch: 'epoch-7' };
    const leaseContract = createInMemoryLeaseContract(createLeaseFixture(ownerA, { sequence: 10 }, 3));

    const blockedTakeover = await leaseContract.claimLease({
      shardId: 'shard-1',
      contender: ownerB,
      at: '2026-04-09T18:00:25.000Z',
      reason: 'rebalance',
      expectedPreviousLeaseVersion: 3
    });
    expect(blockedTakeover).toMatchObject({ status: 'rejected', reason: 'not-expired' });

    const renewed = await leaseContract.renewLease({
      shardId: 'shard-1',
      owner: ownerA,
      leaseVersion: 3,
      at: '2026-04-09T18:00:26.000Z'
    });
    expect(renewed.status).toBe('renewed');

    const staleCommit = await leaseContract.commitCheckpoint({
      shardId: 'shard-1',
      owner: ownerA,
      leaseVersion: 3,
      checkpoint: { sequence: 9 },
      committedAt: '2026-04-09T18:00:27.000Z'
    });
    expect(staleCommit).toMatchObject({ status: 'rejected', reason: 'checkpoint-regression' });

    const forwardCommit = await leaseContract.commitCheckpoint({
      shardId: 'shard-1',
      owner: ownerA,
      leaseVersion: 3,
      checkpoint: { sequence: 12 },
      committedAt: '2026-04-09T18:00:28.000Z'
    });
    expect(forwardCommit).toMatchObject({ status: 'committed' });

    const takeover = await leaseContract.claimLease({
      shardId: 'shard-1',
      contender: ownerB,
      at: '2026-04-09T18:01:00.000Z',
      reason: 'recovery',
      expectedPreviousLeaseVersion: 3
    });
    expect(takeover.status).toBe('claimed');
    if (takeover.status === 'claimed') {
      expect(takeover.state.lease?.owner.workerId).toBe('worker-b');
      expect(takeover.state.lease?.leaseVersion).toBe(4);
      expect(takeover.state.checkpoint.sequence).toBe(12);
    }
  });

  test('rebalance plan semantics cover deterministic scale transitions 4->2 and 4->8', () => {
    const scaleDownPlan: ProjectionShardLeaseRebalancePlan = {
      reason: 'scale-down',
      fromWorkerCount: 4,
      toWorkerCount: 2,
      assignments: [
        { shardId: 'shard-0', fromWorkerId: 'worker-0', toWorkerId: 'worker-0', mode: 'keep' },
        { shardId: 'shard-1', fromWorkerId: 'worker-1', toWorkerId: 'worker-1', mode: 'keep' },
        { shardId: 'shard-2', fromWorkerId: 'worker-2', toWorkerId: 'worker-0', mode: 'handoff' },
        { shardId: 'shard-3', fromWorkerId: 'worker-3', toWorkerId: 'worker-1', mode: 'handoff' }
      ]
    };

    const scaleUpPlan: ProjectionShardLeaseRebalancePlan = {
      reason: 'scale-up',
      fromWorkerCount: 4,
      toWorkerCount: 8,
      assignments: [
        { shardId: 'shard-0', fromWorkerId: 'worker-0', toWorkerId: 'worker-0', mode: 'keep' },
        { shardId: 'shard-1', fromWorkerId: 'worker-1', toWorkerId: 'worker-1', mode: 'keep' },
        { shardId: 'shard-2', fromWorkerId: 'worker-2', toWorkerId: 'worker-6', mode: 'handoff' },
        { shardId: 'shard-3', fromWorkerId: 'worker-3', toWorkerId: 'worker-7', mode: 'handoff' }
      ]
    };

    const downDestinations = new Set(scaleDownPlan.assignments.map((assignment) => assignment.toWorkerId));
    expect(downDestinations).toEqual(new Set(['worker-0', 'worker-1']));
    expect(scaleDownPlan.assignments.filter((assignment) => assignment.mode === 'handoff')).toHaveLength(2);

    const upDestinations = new Set(scaleUpPlan.assignments.map((assignment) => assignment.toWorkerId));
    expect(upDestinations).toEqual(new Set(['worker-0', 'worker-1', 'worker-6', 'worker-7']));
    expect(scaleUpPlan.assignments.filter((assignment) => assignment.mode === 'handoff')).toHaveLength(2);
  });
});
