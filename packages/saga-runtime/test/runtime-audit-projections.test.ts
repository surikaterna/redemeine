import { describe, expect, it } from '@jest/globals';
import {
  createRuntimeAuditLifecycleReadModel,
  type IntentExecutionProjectionRecord,
  type SagaAggregateState
} from '../src';

const createSagaState = (): SagaAggregateState => ({
  id: 'saga-1',
  sagaType: 'order',
  lifecycleState: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:03.000Z',
  transitionVersion: 8,
  totals: {
    transitions: 1,
    observedEvents: 1,
    intents: 1,
    activities: 1
  },
  recent: {
    transitions: [
      {
        fromState: 'active',
        toState: 'completed',
        transitionAt: '2026-01-01T00:00:02.000Z'
      }
    ],
    events: [
      {
        eventType: 'order.approved.event',
        eventId: 'evt-1',
        observedAt: '2026-01-01T00:00:02.000Z'
      }
    ],
    intents: [
      {
        intentId: 'intent-1',
        intentType: 'plugin-request',
        stage: 'acknowledged',
        executionId: 'exec-1',
        recordedAt: '2026-01-01T00:00:02.000Z'
      }
    ],
    activities: [
      {
        activityId: 'activity-1',
        activityName: 'reserve-stock',
        stage: 'succeeded',
        recordedAt: '2026-01-01T00:00:02.000Z'
      }
    ]
  }
});

const execution = (status: IntentExecutionProjectionRecord['status'], updatedAt: string): IntentExecutionProjectionRecord => ({
  id: 'exec-1',
  sagaId: 'saga-1',
  intentId: 'intent-1',
  status,
  attempt: status === 'in_progress' ? 1 : 2,
  retryPolicySnapshot: null,
  responseRef: status === 'succeeded'
    ? { responseKey: 'payments.charge', responseId: 'resp-1' }
    : null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
  metadata: status === 'succeeded' ? { terminal: true } : undefined
});

describe('runtime audit lifecycle read model', () => {
  it('produces the same saga lifecycle history view regardless of input ordering', () => {
    const readModelA = createRuntimeAuditLifecycleReadModel();
    const readModelB = createRuntimeAuditLifecycleReadModel();

    const stateA = createSagaState();
    stateA.recent.events = [
      {
        eventType: 'order.created.event',
        eventId: 'evt-2',
        observedAt: '2026-01-01T00:00:01.000Z'
      },
      ...stateA.recent.events
    ];
    stateA.recent.transitions = [
      {
        fromState: 'idle',
        toState: 'active',
        transitionAt: '2026-01-01T00:00:01.000Z'
      },
      ...stateA.recent.transitions
    ];
    stateA.recent.intents = [
      {
        intentId: 'intent-0',
        intentType: 'dispatch',
        stage: 'created',
        recordedAt: '2026-01-01T00:00:01.000Z'
      },
      ...stateA.recent.intents
    ];
    stateA.recent.activities = [
      {
        activityId: 'activity-0',
        activityName: 'prepare',
        stage: 'started',
        recordedAt: '2026-01-01T00:00:01.000Z'
      },
      ...stateA.recent.activities
    ];

    const stateB = createSagaState();
    stateB.recent.events = [...stateA.recent.events].reverse();
    stateB.recent.transitions = [...stateA.recent.transitions].reverse();
    stateB.recent.intents = [...stateA.recent.intents].reverse();
    stateB.recent.activities = [...stateA.recent.activities].reverse();

    readModelA.upsertSaga(stateA);
    readModelB.upsertSaga(stateB);

    const a = readModelA.querySagaLifecycleHistory({ sagaId: 'saga-1' });
    const b = readModelB.querySagaLifecycleHistory({ sagaId: 'saga-1' });

    expect(a.items).toEqual(b.items);
  });

  it('builds deterministic saga lifecycle history ordering', () => {
    const readModel = createRuntimeAuditLifecycleReadModel();
    readModel.upsertSaga(createSagaState());

    const history = readModel.querySagaLifecycleHistory({ sagaId: 'saga-1' });

    expect(history.items.map((entry) => entry.kind)).toEqual([
      'source_event_observed',
      'state_transition_recorded',
      'intent_lifecycle_recorded',
      'activity_lifecycle_recorded'
    ]);
    expect(history.items.every((entry) => entry.recordedAt === '2026-01-01T00:00:02.000Z')).toBe(true);
  });

  it('tracks deterministic intent execution lifecycle changes', () => {
    const readModel = createRuntimeAuditLifecycleReadModel();

    readModel.upsertIntentExecution(execution('in_progress', '2026-01-01T00:00:01.000Z'));
    readModel.upsertIntentExecution(execution('succeeded', '2026-01-01T00:00:02.000Z'));

    const history = readModel.queryIntentExecutionLifecycleHistory({ executionId: 'exec-1' });

    expect(history.items.map((entry) => entry.kind)).toEqual([
      'created',
      'status_changed',
      'attempt_changed',
      'response_ref_recorded',
      'metadata_changed'
    ]);
    expect(history.items.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('supports deterministic pagination for lifecycle history and intent queries', async () => {
    const readModel = createRuntimeAuditLifecycleReadModel();
    readModel.upsertSaga(createSagaState());

    readModel.upsertIntentExecution({
      id: 'exec-a',
      sagaId: 'saga-1',
      intentId: 'intent-a',
      status: 'failed',
      attempt: 1,
      retryPolicySnapshot: null,
      responseRef: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:03.000Z'
    });
    readModel.upsertIntentExecution({
      id: 'exec-b',
      sagaId: 'saga-1',
      intentId: 'intent-b',
      status: 'in_progress',
      attempt: 1,
      retryPolicySnapshot: null,
      responseRef: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:04.000Z'
    });

    const page1 = readModel.querySagaLifecycleHistory({ sagaId: 'saga-1', limit: 2 });
    const page2 = readModel.querySagaLifecycleHistory({
      sagaId: 'saga-1',
      limit: 2,
      cursor: page1.nextCursor
    });

    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeUndefined();

    const query = await readModel.queryIntentExecutions({
      sagaId: 'saga-1',
      statuses: ['in_progress', 'failed'],
      limit: 1
    });
    const queryNext = await readModel.queryIntentExecutions({
      sagaId: 'saga-1',
      statuses: ['in_progress', 'failed'],
      limit: 1,
      cursor: query.nextCursor
    });

    expect(query.items[0]?.id).toBe('exec-b');
    expect(queryNext.items[0]?.id).toBe('exec-a');
  });
});
