import { describe, expect, it } from '@jest/globals';
import {
  createInMemoryPersistencePluginV1,
  createInMemorySchedulerPluginV1,
  createInMemorySideEffectsPluginV1,
  createInMemoryTelemetryPluginV1,
  runReferenceAdapterFlowV1,
  type SagaPluginRequestIntent,
  type SagaRuntimeReferenceAdapters
} from '../src/referenceAdapters';

type DeliveryMode = 'at_least_once' | 'effectively_once';
type FaultOutcome = 'succeeded' | 'failed';

interface ReliabilityTransition {
  readonly stage: 'received' | 'dispatched' | 'succeeded' | 'failed' | 'retry_scheduled' | 'deduped' | 'dead_lettered';
  readonly executionId: string;
  readonly attempt: number;
  readonly mode: DeliveryMode;
  readonly reason: 'initial' | 'retry' | 'redelivery';
}

interface DeadLetterRecord {
  readonly executionId: string;
  readonly attempts: number;
  readonly mode: DeliveryMode;
}

interface DeliveryResult {
  readonly executionId: string;
  readonly attempt: number;
  readonly shouldRetry: boolean;
  readonly deduped: boolean;
}

const metadata = {
  sagaId: 'saga-reliability-1',
  correlationId: 'corr-reliability-1',
  causationId: 'cause-reliability-1'
} as const;

const createIntent = (): SagaPluginRequestIntent => ({
  type: 'plugin-request',
  plugin_key: 'payments',
  action_name: 'authorize',
  action_kind: 'request_response',
  execution_payload: { amount: 1900 },
  routing_metadata: {
    response_handler_key: 'payments.authorize.ok',
    error_handler_key: 'payments.authorize.failed',
    handler_data: { orderId: 'order-777' }
  },
  metadata
});

const createReliabilityHarness = (mode: DeliveryMode, faultPlan: readonly FaultOutcome[], maxAttempts = 2) => {
  const plannedFaults = [...faultPlan];
  const transitions: ReliabilityTransition[] = [];
  const deadLetters: DeadLetterRecord[] = [];
  const attemptsByExecutionId = new Map<string, number>();
  const deliveryCountByLogicalIntent = new Map<string, number>();
  const handledExecutionIds: string[] = [];

  const adapters: SagaRuntimeReferenceAdapters = {
    persistence: createInMemoryPersistencePluginV1(),
    scheduler: createInMemorySchedulerPluginV1(),
    telemetry: createInMemoryTelemetryPluginV1(),
    sideEffects: createInMemorySideEffectsPluginV1(() => {
      const outcome = plannedFaults.shift() ?? 'succeeded';
      if (outcome === 'failed') {
        return {
          status: 'failed',
          error: 'fault-injected: simulated transport timeout'
        };
      }

      return {
        status: 'succeeded',
        responseRef: {
          responseKey: 'payments.authorize',
          responseId: `resp-${handledExecutionIds.length + 1}`,
          receivedAt: '2026-01-01T00:00:01.000Z'
        }
      };
    })
  };

  const logicalIntentKey = (sagaId: string, intent: SagaPluginRequestIntent): string => (
    `${sagaId}:${intent.plugin_key}.${intent.action_name}:${intent.metadata.correlationId}`
  );

  const stableExecutionId = (sagaId: string, intent: SagaPluginRequestIntent): string => (
    `${logicalIntentKey(sagaId, intent)}:execution`
  );

  const nextExecutionIdentity = (sagaId: string, intent: SagaPluginRequestIntent): { executionId: string; intentId: string } => {
    const key = logicalIntentKey(sagaId, intent);
    if (mode === 'effectively_once') {
      const executionId = stableExecutionId(sagaId, intent);
      return {
        executionId,
        intentId: executionId
      };
    }

    const deliveryCount = (deliveryCountByLogicalIntent.get(key) ?? 0) + 1;
    deliveryCountByLogicalIntent.set(key, deliveryCount);
    const executionId = `${stableExecutionId(sagaId, intent)}:delivery:${deliveryCount}`;
    return {
      executionId,
      intentId: executionId
    };
  };

  const deliver = async (
    sagaId: string,
    intent: SagaPluginRequestIntent,
    reason: 'initial' | 'retry' | 'redelivery'
  ): Promise<DeliveryResult> => {
    const effectiveExecutionId = stableExecutionId(sagaId, intent);
    const currentAttempt = attemptsByExecutionId.get(effectiveExecutionId) ?? 0;
    transitions.push({
      stage: 'received',
      executionId: effectiveExecutionId,
      attempt: currentAttempt + 1,
      mode,
      reason
    });

    if (mode === 'effectively_once') {
      const existing = adapters.persistence.intentExecutionProjection.getById(effectiveExecutionId);
      if (existing?.status === 'succeeded') {
        transitions.push({
          stage: 'deduped',
          executionId: effectiveExecutionId,
          attempt: currentAttempt,
          mode,
          reason
        });
        return {
          executionId: effectiveExecutionId,
          attempt: currentAttempt,
          shouldRetry: false,
          deduped: true
        };
      }
    }

    const identity = nextExecutionIdentity(sagaId, intent);
    transitions.push({
      stage: 'dispatched',
      executionId: identity.executionId,
      attempt: currentAttempt + 1,
      mode,
      reason
    });

    handledExecutionIds.push(identity.executionId);

    const result = await runReferenceAdapterFlowV1(adapters, {
      sagaId,
      intents: [intent],
      nowIso: '2026-01-01T00:00:00.000Z',
      resolveExecutionIdentity: () => identity
    });

    const status = result.responseCorrelations[0]?.status;
    const attempt = currentAttempt + 1;
    attemptsByExecutionId.set(effectiveExecutionId, attempt);

    if (status === 'failed') {
      transitions.push({
        stage: 'failed',
        executionId: identity.executionId,
        attempt,
        mode,
        reason
      });

      if (attempt >= maxAttempts) {
        transitions.push({
          stage: 'dead_lettered',
          executionId: identity.executionId,
          attempt,
          mode,
          reason
        });
        deadLetters.push({
          executionId: identity.executionId,
          attempts: attempt,
          mode
        });
        return {
          executionId: identity.executionId,
          attempt,
          shouldRetry: false,
          deduped: false
        };
      }

      transitions.push({
        stage: 'retry_scheduled',
        executionId: identity.executionId,
        attempt,
        mode,
        reason
      });
      return {
        executionId: identity.executionId,
        attempt,
        shouldRetry: true,
        deduped: false
      };
    }

    transitions.push({
      stage: 'succeeded',
      executionId: identity.executionId,
      attempt,
      mode,
      reason
    });
    return {
      executionId: identity.executionId,
      attempt,
      shouldRetry: false,
      deduped: false
    };
  };

  const listPersisted = () => adapters.persistence.listIntentExecutionsBySagaId(metadata.sagaId);

  return {
    adapters,
    deliver,
    listPersisted,
    transitions,
    deadLetters,
    handledExecutionIds
  };
};

describe('reliability validation: delivery modes and idempotency boundary', () => {
  it('distinguishes at_least_once from effectively_once on success redelivery', async () => {
    const atLeastOnce = createReliabilityHarness('at_least_once', ['succeeded', 'succeeded']);
    const effectivelyOnce = createReliabilityHarness('effectively_once', ['succeeded', 'succeeded']);

    await atLeastOnce.deliver(metadata.sagaId, createIntent(), 'initial');
    await atLeastOnce.deliver(metadata.sagaId, createIntent(), 'redelivery');

    await effectivelyOnce.deliver(metadata.sagaId, createIntent(), 'initial');
    const deduped = await effectivelyOnce.deliver(metadata.sagaId, createIntent(), 'redelivery');

    expect(atLeastOnce.adapters.sideEffects.listHandled()).toHaveLength(2);
    expect(atLeastOnce.listPersisted().map((record) => record.id)).toEqual([
      `${metadata.sagaId}:payments.authorize:${metadata.correlationId}:execution:delivery:1`,
      `${metadata.sagaId}:payments.authorize:${metadata.correlationId}:execution:delivery:2`
    ]);

    expect(effectivelyOnce.adapters.sideEffects.listHandled()).toHaveLength(1);
    expect(effectivelyOnce.listPersisted().map((record) => record.id)).toEqual([
      `${metadata.sagaId}:payments.authorize:${metadata.correlationId}:execution`
    ]);
    expect(deduped.deduped).toBe(true);
    expect(effectivelyOnce.transitions).toContainEqual(
      expect.objectContaining({ stage: 'deduped', mode: 'effectively_once', reason: 'redelivery' })
    );
  });

  it('records deterministic retry then dead-letter transitions under fault injection', async () => {
    const runScenario = async (mode: DeliveryMode) => {
      const harness = createReliabilityHarness(mode, ['failed', 'failed'], 2);
      const intent = createIntent();

      let nextReason: 'initial' | 'retry' = 'initial';
      let outcome = await harness.deliver(metadata.sagaId, intent, nextReason);

      while (outcome.shouldRetry) {
        nextReason = 'retry';
        outcome = await harness.deliver(metadata.sagaId, intent, nextReason);
      }

      return harness;
    };

    const atLeastOnce = await runScenario('at_least_once');
    const effectivelyOnce = await runScenario('effectively_once');

    for (const harness of [atLeastOnce, effectivelyOnce]) {
      expect(harness.deadLetters).toHaveLength(1);
      expect(harness.transitions.map((entry) => entry.stage)).toEqual([
        'received',
        'dispatched',
        'failed',
        'retry_scheduled',
        'received',
        'dispatched',
        'failed',
        'dead_lettered'
      ]);
    }

    expect(atLeastOnce.listPersisted()).toHaveLength(2);
    expect(effectivelyOnce.listPersisted()).toHaveLength(1);
    expect(effectivelyOnce.listPersisted()[0]?.status).toBe('failed');
  });

  it('keeps retry/redelivery execution counts observable in telemetry counters', async () => {
    const atLeastOnce = createReliabilityHarness('at_least_once', ['failed', 'succeeded', 'succeeded'], 3);

    const first = await atLeastOnce.deliver(metadata.sagaId, createIntent(), 'initial');
    if (first.shouldRetry) {
      await atLeastOnce.deliver(metadata.sagaId, createIntent(), 'retry');
    }
    await atLeastOnce.deliver(metadata.sagaId, createIntent(), 'redelivery');

    const counters = atLeastOnce.adapters.telemetry.snapshot().counters;
    expect(counters['saga.intent.received']).toBe(3);
    expect(counters['saga.intent.executed']).toBe(3);
    expect(counters['saga.intent.execution_failed']).toBe(1);
    expect(counters['saga.intent.execution_succeeded']).toBe(2);
  });
});
