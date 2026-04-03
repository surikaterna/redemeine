import { describe, expect, it } from '@jest/globals';
import type {
  IntentExecution,
  IntentExecutionCreateCommandPayload,
  IntentExecutionMarkTerminalCommandPayload,
  IntentExecutionProjection,
  IntentExecutionRecordAttemptCommandPayload,
  IntentExecutionRecordResponseRefCommandPayload,
  IntentExecutionResponseRef,
  IntentExecutionRetryPolicySnapshot,
  IntentExecutionStatus,
  SagaAggregateProjection,
  SagaCreateInstanceCommandPayload,
  SagaIntentLifecycleRecord
} from '../src/SagaAggregate';

describe('saga-runtime v1 domain contract types', () => {
  it('uses id as saga aggregate identity in create payload', () => {
    const createPayload: SagaCreateInstanceCommandPayload = {
      id: 'saga-123',
      sagaType: 'order_fulfillment'
    };

    expect(createPayload.id).toBe('saga-123');
    expect('sagaId' in (createPayload as unknown as Record<string, unknown>)).toBe(false);
  });

  it('keeps intent execution retryPolicy snapshot and responseRef fields', () => {
    const retryPolicySnapshot: IntentExecutionRetryPolicySnapshot = {
      maxAttempts: 5,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      backoffMultiplier: 2
    };

    const responseRef: IntentExecutionResponseRef = {
      responseKey: 'dispatch_result',
      responseId: 'resp-7'
    };

    const intentExecution: IntentExecution = {
      id: 'exec-1',
      sagaId: 'saga-123',
      intentId: 'intent-42',
      status: 'in_progress',
      attempt: 2,
      retryPolicySnapshot,
      responseRef,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z'
    };

    expect(intentExecution.retryPolicySnapshot?.maxAttempts).toBe(5);
    expect(intentExecution.responseRef?.responseId).toBe('resp-7');
  });

  it('keeps command payload contracts without top-level discriminators', () => {
    const createPayload: IntentExecutionCreateCommandPayload = {
      id: 'exec-1',
      sagaId: 'saga-123',
      intentId: 'intent-42'
    };

    const attemptPayload: IntentExecutionRecordAttemptCommandPayload = {
      id: 'exec-1',
      attempt: 3,
      status: 'in_progress'
    };

    const responsePayload: IntentExecutionRecordResponseRefCommandPayload = {
      id: 'exec-1',
      responseRef: {
        responseKey: 'payment',
        responseId: 'resp-22'
      }
    };

    const terminalPayload: IntentExecutionMarkTerminalCommandPayload = {
      id: 'exec-1',
      status: 'succeeded'
    };

    for (const payload of [createPayload, attemptPayload, responsePayload, terminalPayload]) {
      expect('type' in (payload as unknown as Record<string, unknown>)).toBe(false);
      expect('kind' in (payload as unknown as Record<string, unknown>)).toBe(false);
    }
  });

  it('uses snake_case status values for intent execution lifecycle enums', () => {
    const inProgress: IntentExecutionStatus = 'in_progress';
    const timedOut: IntentExecutionStatus = 'timed_out';

    expect(inProgress).toBe('in_progress');
    expect(timedOut).toBe('timed_out');
  });

  it('allows projection interfaces keyed by aggregate identity id', () => {
    const sagaProjection: SagaAggregateProjection = {
      getById: (_id) => null,
      upsert: () => undefined
    };

    const executionProjection: IntentExecutionProjection = {
      getById: (_id) => null,
      upsert: () => undefined
    };

    expect(sagaProjection.getById('saga-123')).toBeNull();
    expect(executionProjection.getById('exec-1')).toBeNull();
  });

  it('supports responseRef and retryPolicySnapshot on saga intent lifecycle records', () => {
    const lifecycleRecord: SagaIntentLifecycleRecord = {
      intentId: 'intent-42',
      intentType: 'dispatch',
      stage: 'acknowledged',
      executionId: 'exec-1',
      retryPolicySnapshot: { maxAttempts: 4 },
      responseRef: { responseKey: 'inventory', responseId: 'resp-44' },
      recordedAt: '2026-01-01T00:00:02.000Z'
    };

    expect(lifecycleRecord.executionId).toBe('exec-1');
    expect(lifecycleRecord.retryPolicySnapshot?.maxAttempts).toBe(4);
    expect(lifecycleRecord.responseRef?.responseKey).toBe('inventory');
  });
});
