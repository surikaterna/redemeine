import { describe, expect, test } from 'bun:test';
import {
  evaluateCutoverReadiness,
  transitionToCutover,
  transitionToRollback
} from '../src';
import type {
  Checkpoint,
  ProjectionEnvelopeValidationCandidate,
  ProjectionEnvelopeValidationResult,
  ProjectionIngress,
  ProjectionIngressAckDecision,
  ProjectionIngressDecision,
  ProjectionIngressEnvelope,
  ProjectionIngressNackDecision,
  ProjectionIngressPushManyResult,
  ProjectionIngressPushResult,
  ProjectionPoisonClassificationModel,
  ProjectionPoisonClassifier,
  ProjectionEnvelopeValidator,
  ProjectionDedupeKey,
  ProjectionDedupeRetentionPolicy,
  ProjectionHydrationHint,
  ProjectionHydrationMode,
  ProjectionHydrationStatus,
  ProjectionMetadataEnvelope,
  ProjectionStoreAtomicManyContract,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest,
  ProjectionStoreContract,
  ProjectionStoreDedupeRetentionContract,
  ProjectionStoreDocumentWrite,
  ProjectionStoreDurableDedupeContract,
  ProjectionShardCheckpointLeaseContract,
  ProjectionShardCheckpointLeaseState,
  ProjectionShardCheckpointCommitResult,
  ProjectionShardLeaseClaimResult,
  ProjectionShardLeaseRebalancePlan,
  ProjectionShardLeaseRenewResult,
  ProjectionShardOwnerIdentity,
  ProjectionStoreWriteFailure,
  ProjectionRouterFanoutEnvelope,
  ProjectionStoreWriteWatermark,
  ProjectionGenerationSwitchContract,
  ProjectionRebuildLifecycleState
} from '../src';
import {
  DEFAULT_PROJECTION_POISON_CLASSIFICATION_MODEL,
  classifyProjectionEnvelopeCandidate,
  PROJECTION_DEDUPE_KEY_VERSION,
  decodeProjectionDedupeKey,
  encodeProjectionDedupeKey,
  evaluateProjectionDedupeRetention
} from '../src';

function createAckDecision(): ProjectionIngressAckDecision {
  return {
    status: 'ack',
    lifecycle: [
      { stage: 'received' },
      { stage: 'published_durable' },
      { stage: 'ackable' }
    ]
  };
}

function createNackDecision(
  cause: ProjectionIngressNackDecision['cause'],
  retryable: boolean,
  reason: string
): ProjectionIngressNackDecision {
  return {
    status: 'nack',
    retryable,
    reason,
    cause,
    lifecycle: cause === 'timeout'
      ? [
        { stage: 'received' },
        { stage: 'nack', cause }
      ]
      : [
        { stage: 'received' },
        { stage: 'published_durable' },
        { stage: 'nack', cause }
      ]
  };
}

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
            decision: createAckDecision()
          }
        };
      },
      async pushMany(envelopes: readonly ProjectionIngressEnvelope[]): Promise<ProjectionIngressPushManyResult> {
        return {
          items: envelopes.map((envelope) => ({
            messageId: envelope.metadata.messageId,
            decision: envelope.metadata.retryCount > 1
              ? createNackDecision('timeout', true, 'publish-confirm-timeout')
              : envelope.metadata.retryCount > 0
                ? createNackDecision('failure', true, 'retry-once')
                : createAckDecision()
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
    if (single.item.decision.status === 'ack') {
      expect(single.item.decision.lifecycle).toEqual([
        { stage: 'received' },
        { stage: 'published_durable' },
        { stage: 'ackable' }
      ]);
    }

    const many = await ingress.pushMany([
      envelope,
      {
        ...envelope,
        metadata: {
          ...envelope.metadata,
          messageId: 'msg-2',
          retryCount: 1
        }
      },
      {
        ...envelope,
        metadata: {
          ...envelope.metadata,
          messageId: 'msg-3',
          retryCount: 2
        }
      }
    ]);

    expect(many.items).toHaveLength(3);
    expect(many.items[0].decision.status).toBe('ack');
    expect(many.items[1].decision).toEqual({
      status: 'nack',
      retryable: true,
      reason: 'retry-once',
      cause: 'failure',
      lifecycle: [
        { stage: 'received' },
        { stage: 'published_durable' },
        { stage: 'nack', cause: 'failure' }
      ]
    });
    expect(many.items[2].decision).toEqual({
      status: 'nack',
      retryable: true,
      reason: 'publish-confirm-timeout',
      cause: 'timeout',
      lifecycle: [
        { stage: 'received' },
        { stage: 'nack', cause: 'timeout' }
      ]
    });
    });

    if (many.items[0].decision.status === 'ack') {
      expect(many.items[0].decision.lifecycle).toEqual([
        { stage: 'received' },
        { stage: 'published_durable' },
        { stage: 'ackable' }
      ]);
    }
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
    const canonicalKey = encodeProjectionDedupeKey({
      projectionName: 'invoice-summary',
      aggregateType: 'invoice',
      aggregateId: '1',
      sequence: 11
    });

    const dedupeStore: ProjectionStoreDurableDedupeContract = {
      async getDedupeCheckpoint(key) {
        return key === canonicalKey ? { sequence: 11 } : null;
      }
    };

    const dedupeRetentionPolicy: ProjectionDedupeRetentionPolicy = {
      windowMs: 30_000,
      ttlMs: 300_000,
      cleanup: {
        mode: 'scheduled',
        maxDeletesPerRun: 1_000
      }
    };

    const dedupeRetention: ProjectionStoreDedupeRetentionContract = {
      async setDedupeRetentionPolicy(policy) {
        expect(policy.cleanup?.mode).toBe('scheduled');
        expect(policy.ttlMs).toBeGreaterThanOrEqual(policy.windowMs);
      }
    };

    await dedupeRetention.setDedupeRetentionPolicy(dedupeRetentionPolicy);

    const atomicManyOnly: ProjectionStoreAtomicManyContract = {
      async commitAtomicMany(request: ProjectionStoreCommitAtomicManyRequest): Promise<ProjectionStoreAtomicManyResult> {
        if (request.writes.length === 0) {
          return {
            status: 'rejected',
            highestWatermark: null,
            failedAtIndex: 0,
            failure: {
              category: 'terminal',
              code: 'invalid-request',
              message: 'no writes',
              retryable: false
            },
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
      expect(rejected.failure).toEqual({
        category: 'terminal',
        code: 'invalid-request',
        message: 'no writes',
        retryable: false
      });
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
            upserts: [{
              key: encodeProjectionDedupeKey({
                projectionName: 'invoice-summary',
                aggregateType: 'invoice',
                aggregateId: '1',
                sequence: 21
              }),
              checkpoint: { sequence: 21 }
            }]
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

    const dedupeCheckpoint = await store.getDedupeCheckpoint(canonicalKey);
    expect(dedupeCheckpoint?.sequence).toBe(11);
  });

  test('poison-message classifier is deterministic and adapter-neutral', () => {
    const cases: Array<{ candidate: ProjectionEnvelopeValidationCandidate; expected: ProjectionEnvelopeValidationResult }> = [
      {
        candidate: {
          payloadBytes: 10,
          maxPayloadBytes: 1024,
          parseable: true,
          binary: false,
          envelopeShapeValid: true
        },
        expected: { status: 'valid' }
      },
      {
        candidate: {
          payloadBytes: 10,
          maxPayloadBytes: 1024,
          parseable: true,
          binary: false,
          envelopeShapeValid: false
        },
        expected: { status: 'poison', poisonClass: 'malformed', action: 'dead-letter' }
      },
      {
        candidate: {
          payloadBytes: 10,
          maxPayloadBytes: 1024,
          parseable: false,
          binary: false,
          envelopeShapeValid: true
        },
        expected: { status: 'poison', poisonClass: 'garbage', action: 'drop' }
      },
      {
        candidate: {
          payloadBytes: 2048,
          maxPayloadBytes: 1024,
          parseable: true,
          binary: false,
          envelopeShapeValid: true
        },
        expected: { status: 'poison', poisonClass: 'oversized', action: 'retry' }
      },
      {
        candidate: {
          payloadBytes: 64,
          maxPayloadBytes: 1024,
          parseable: false,
          binary: true,
          envelopeShapeValid: false
        },
        expected: { status: 'poison', poisonClass: 'binary', action: 'quarantine' }
      }
    ];

    for (const testCase of cases) {
      expect(classifyProjectionEnvelopeCandidate(testCase.candidate)).toEqual(testCase.expected);
    }
  });

  test('poison class/action contracts support custom mapping', () => {
    const customModel: ProjectionPoisonClassificationModel = {
      malformed: 'quarantine',
      garbage: 'dead-letter',
      binary: 'drop',
      oversized: 'retry'
    };

    const classifier: ProjectionPoisonClassifier = {
      classify(poisonClass) {
        return customModel[poisonClass];
      }
    };

    const validator: ProjectionEnvelopeValidator = {
      validate(candidate) {
        const outcome = classifyProjectionEnvelopeCandidate(candidate, customModel);
        if (outcome.status === 'valid') {
          return outcome;
        }

        return {
          ...outcome,
          action: classifier.classify(outcome.poisonClass)
        };
      }
    };

    const outcome = validator.validate({
      payloadBytes: 16,
      maxPayloadBytes: 32,
      parseable: true,
      binary: false,
      envelopeShapeValid: false
    });

    expect(DEFAULT_PROJECTION_POISON_CLASSIFICATION_MODEL).toEqual({
      malformed: 'dead-letter',
      garbage: 'drop',
      binary: 'quarantine',
      oversized: 'retry'
    });
    expect(outcome).toEqual({
      status: 'poison',
      poisonClass: 'malformed',
      action: 'quarantine'
    });
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

  test('dedupe key contract is deterministic and round-trips encoded fields', () => {
    const input: Omit<ProjectionDedupeKey, 'version'> = {
      projectionName: 'invoice-summary',
      aggregateType: 'invoice domain',
      aggregateId: 'id/with|delimiters?and=spaces',
      sequence: 42
    };

    const encoded = encodeProjectionDedupeKey(input);
    const encodedAgain = encodeProjectionDedupeKey(input);
    expect(encodedAgain).toBe(encoded);

    const decoded = decodeProjectionDedupeKey(encoded);
    expect(decoded).toEqual({
      version: PROJECTION_DEDUPE_KEY_VERSION,
      ...input
    });

    expect(decodeProjectionDedupeKey('v2|a|b|c|1')).toBeNull();
    expect(decodeProjectionDedupeKey('v1|a|b|c|not-a-number')).toBeNull();
  });

  test('dedupe retention evaluation keeps safety window then expires at ttl', () => {
    const now = Date.parse('2026-04-09T18:05:00.000Z');
    const policy: ProjectionDedupeRetentionPolicy = {
      windowMs: 60_000,
      ttlMs: 300_000,
      cleanup: { mode: 'lazy' }
    };

    const withinWindow = evaluateProjectionDedupeRetention({
      policy,
      checkpoint: { sequence: 11, timestamp: '2026-04-09T18:04:30.000Z' },
      now
    });
    expect(withinWindow).toBe('retain');

    const afterWindowBeforeTtl = evaluateProjectionDedupeRetention({
      policy,
      checkpoint: { sequence: 11, timestamp: '2026-04-09T18:03:30.000Z' },
      now
    });
    expect(afterWindowBeforeTtl).toBe('retain');

    const atTtl = evaluateProjectionDedupeRetention({
      policy,
      checkpoint: { sequence: 11, timestamp: '2026-04-09T18:00:00.000Z' },
      now
    });
    expect(atTtl).toBe('eligible_for_cleanup');

  });

  test('hydration mode/status contracts and _projection metadata stay minimal', () => {
    const hydrationMode: ProjectionHydrationMode = 'snapshot_plus_tail';
    const statuses: ProjectionHydrationStatus[] = ['hydrating', 'ready', 'rebuilding', 'failed'];

    const metadata: ProjectionMetadataEnvelope = {
      status: 'hydrating',
      generation: 3,
      watermark: { sequence: 101, timestamp: '2026-04-09T18:00:02.000Z' },
      updatedAt: '2026-04-09T18:00:02.000Z',
      adapter: {
        provider: 'mongodb'
      }
    };

    const hint: ProjectionHydrationHint = {
      mode: hydrationMode,
      snapshotWatermark: { sequence: 100 },
      asOf: '2026-04-09T18:00:00.000Z'
    };

    expect(statuses).toEqual(['hydrating', 'ready', 'rebuilding', 'failed']);
    expect(hint.mode).toBe('snapshot_plus_tail');
    expect(metadata.status).toBe('hydrating');
    expect(metadata.generation).toBe(3);
    expect(metadata.watermark?.sequence).toBe(101);
    expect(Object.prototype.hasOwnProperty.call(metadata, 'projectionName')).toBe(false);
  });

  test('cutover readiness is deterministic from criteria', () => {
    const ready = evaluateCutoverReadiness({
      shadowCaughtUp: true,
      validationPassed: true,
      writesQuiesced: true
    });

    expect(ready).toEqual({
      ready: true,
      unmetCriteria: []
    });

    const notReady = evaluateCutoverReadiness({
      shadowCaughtUp: true,
      validationPassed: false,
      writesQuiesced: false
    });

    expect(notReady.ready).toBe(false);
    expect(notReady.unmetCriteria).toEqual(['validationPassed', 'writesQuiesced']);
  });

  test('cutover and rollback transitions are deterministic', async () => {
    const initial: ProjectionRebuildLifecycleState = {
      activeGenerationId: 'gen-a',
      shadowGenerationId: 'gen-b',
      status: 'shadow_ready',
      checkpoint: { sequence: 10 }
    };

    const notCutover = transitionToCutover({
      state: initial,
      checkpoint: { sequence: 11 },
      readiness: {
        shadowCaughtUp: true,
        validationPassed: false,
        writesQuiesced: true
      }
    });
    expect(notCutover).toEqual(initial);

    const cutover = transitionToCutover({
      state: initial,
      checkpoint: { sequence: 12 },
      readiness: {
        shadowCaughtUp: true,
        validationPassed: true,
        writesQuiesced: true
      }
    });

    expect(cutover).toEqual({
      activeGenerationId: 'gen-b',
      shadowGenerationId: 'gen-a',
      status: 'live',
      checkpoint: { sequence: 12 }
    });

    const notRollback = transitionToRollback({
      state: cutover,
      checkpoint: { sequence: 13 }
    });
    expect(notRollback).toEqual(cutover);

    const rollbackReadyState: ProjectionRebuildLifecycleState = {
      ...cutover,
      status: 'rollback_ready'
    };
    const rolledBack = transitionToRollback({
      state: rollbackReadyState,
      checkpoint: { sequence: 14 }
    });

    expect(rolledBack).toEqual({
      activeGenerationId: 'gen-a',
      shadowGenerationId: 'gen-b',
      status: 'rolled_back',
      checkpoint: { sequence: 14 }
    });

    const switchContract: ProjectionGenerationSwitchContract = {
      async cutover(request) {
        return transitionToCutover(request);
      },
      async rollback(request) {
        return transitionToRollback(request);
      }
    };

    const contractCutover = await switchContract.cutover({
      state: initial,
      checkpoint: { sequence: 15 },
      readiness: {
        shadowCaughtUp: true,
        validationPassed: true,
        writesQuiesced: true
      }
    });
    expect(contractCutover.status).toBe('live');
  });

  test('store failure taxonomy keeps deterministic retryability', () => {
    const conflict: ProjectionStoreWriteFailure = {
      category: 'conflict',
      code: 'occ-conflict',
      message: 'expected revision mismatch',
      retryable: true
    };

    const transient: ProjectionStoreWriteFailure = {
      category: 'transient',
      code: 'io-timeout',
      message: 'temporary network timeout',
      retryable: true
    };

    const terminal: ProjectionStoreWriteFailure = {
      category: 'terminal',
      code: 'invalid-request',
      message: 'no writes',
      retryable: false
    };

    expect(conflict.retryable).toBe(true);
    expect(transient.retryable).toBe(true);
    expect(terminal.retryable).toBe(false);
  });
});
