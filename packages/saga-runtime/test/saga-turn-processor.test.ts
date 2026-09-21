import { describe, expect, it } from '@jest/globals';
import {
  compileSagaRoutes,
  createStartEventBindings,
  processSagaSourceEvent,
  SagaTurnError,
  SagaTurnIntegrityError,
  SagaTurnPermanentError,
  SagaTurnUnsupportedError
} from '../src/index';
import {
  createCounters,
  createStartOnlyTable,
  createTurnDefinition,
  createTurnTable,
  FakeTurnRepository,
  sourceEvent
} from './fixtures/turn-processor.fixture';

function payloadOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || !('payload' in value)) throw new Error('expected event payload');
  const payload = value.payload;
  if (typeof payload !== 'object' || payload === null) throw new Error('expected object payload');
  return payload;
}

function stateCount(value: unknown): number {
  const payload = payloadOf(value);
  const state = payload.state;
  if (typeof state !== 'object' || state === null || !('count' in state) || typeof state.count !== 'number') {
    throw new Error('expected persisted count');
  }
  return state.count;
}

function stateOf(value: unknown): Record<string, unknown> {
  const state = payloadOf(value).state;
  if (typeof state !== 'object' || state === null) throw new Error('expected persisted state');
  return state;
}

async function initialize(repository: FakeTurnRepository, name: string) {
  const counters = createCounters();
  const table = createTurnTable(name, counters);
  const outcomes = await processSagaSourceEvent(table, repository, sourceEvent());
  return { counters, table, outcome: outcomes[0] };
}

describe('durable saga state-turn processor', () => {
  it('initializes with deterministic event order in one append without invoking handlers', async () => {
    const repository = new FakeTurnRepository();
    const { counters, outcome } = await initialize(repository, 'initial');

    expect(outcome?.status).toBe('committed');
    expect(counters).toMatchObject({ initial: 1, start: 0, handler: 0 });
    expect(repository.appendCalls).toHaveLength(1);
    expect(repository.appendCalls[0]?.expectedNextCommitSequence).toBe(0);
    expect(repository.appendCalls[0]?.events.map(({ type }) => type)).toEqual([
      'saga.instance_created.event',
      'saga.source_event_observed.event',
      'saga.business_state_recorded.event'
    ]);
    expect(payloadOf(repository.appendCalls[0]?.events[0]).createdAt).toBe('2026-09-21T10:00:00.000Z');
    expect(payloadOf(repository.appendCalls[0]?.events[2]).recordedAt).toBe('2026-09-21T10:00:00.000Z');
  });

  it('runs one on handler against authoritative state and persists its draft', async () => {
    const repository = new FakeTurnRepository();
    const { counters, table } = await initialize(repository, 'existing');
    repository.appendCalls.length = 0;

    const result = await processSagaSourceEvent(table, repository, sourceEvent({
      type: 'turn.order-paid.v1.event',
      payload: { orderId: 'order-1', amount: 3 },
      commitId: 'source-commit-2',
      eventId: 'source-event-2',
      eventIndex: 1
    }));

    expect(result[0]?.status).toBe('committed');
    expect(counters.handler).toBe(1);
    expect(repository.appendCalls).toHaveLength(1);
    expect(repository.appendCalls[0]?.events.map(({ type }) => type)).toEqual([
      'saga.source_event_observed.event',
      'saga.business_state_recorded.event'
    ]);
    expect(stateCount(repository.appendCalls[0]?.events[1])).toBe(3);
  });

  it('returns no outcomes for no match and unmatched for an absent on-only route', async () => {
    const repository = new FakeTurnRepository();
    const table = createTurnTable('unmatched', createCounters());
    expect(await processSagaSourceEvent(table, repository, sourceEvent({ type: 'other.event' }))).toEqual([]);
    const onOnly = await processSagaSourceEvent(table, repository, sourceEvent({ type: 'turn.order-paid.v1.event' }));
    expect(onOnly[0]).toMatchObject({ status: 'unmatched', reason: 'absent_on_route' });
    expect(repository.appendCalls).toHaveLength(0);
  });

  it('treats an existing start-only route as a no-op without a duplicate turn', async () => {
    const repository = new FakeTurnRepository();
    const counters = createCounters();
    const table = createStartOnlyTable('start-only', counters);
    await processSagaSourceEvent(table, repository, sourceEvent());
    repository.appendCalls.length = 0;
    const result = await processSagaSourceEvent(table, repository, sourceEvent({ commitId: 'source-commit-2', eventId: 'event-2' }));
    expect(result[0]).toMatchObject({ status: 'no_op', reason: 'existing_start_only' });
    expect(repository.appendCalls).toHaveLength(0);
    expect(counters).toMatchObject({ initial: 1, start: 0, handler: 0 });
  });

  it('uses initiation for new start+on events and on handling for existing instances', async () => {
    const repository = new FakeTurnRepository();
    const { counters, table } = await initialize(repository, 'branching');
    expect(counters.handler).toBe(0);
    await processSagaSourceEvent(table, repository, sourceEvent({ commitId: 'source-commit-2', eventId: 'event-2' }));
    expect(counters.handler).toBe(1);
    expect(counters.start).toBe(0);
  });

  it('uses one canonical public aggregate event for predicates, mapping, correlation, and handlers', async () => {
    const repository = new FakeTurnRepository();
    const { counters, table } = await initialize(repository, 'canonical-envelope');
    expect(counters.whenEvent).toBe(counters.startEvent);
    expect(counters.startEvent).toBe(counters.onCorrelationEvent);

    repository.appendCalls.length = 0;
    await processSagaSourceEvent(table, repository, sourceEvent({ commitId: 'source-2', eventId: 'public-event-2' }));
    const envelope = counters.handlerEvent;
    if (typeof envelope !== 'object' || envelope === null) throw new Error('expected handler envelope');
    expect(counters.whenEvent).toBe(envelope);
    expect(counters.startEvent).toBe(envelope);
    expect(counters.onCorrelationEvent).toBe(envelope);
    expect(envelope).toEqual({
      id: 'public-event-2',
      type: 'turn.order-placed.v1.event',
      payload: { orderId: 'order-1' },
      aggregateType: 'turn-orders',
      aggregateId: 'order-1',
      sequence: 4,
      metadata: {
        tenant: 'tenant-1',
        version: 4,
        correlationId: 'correlation-1',
        causationId: 'causation-1'
      }
    });
    expect(stateOf(repository.appendCalls[0]?.events[1]).lastEventId).toBe('public-event-2');
    expect(Object.keys(envelope)).not.toEqual(expect.arrayContaining(['partitionId', 'streamId', 'commitId', 'eventIndex', 'createDateTime']));
  });

  it.each([
    ['intent', SagaTurnUnsupportedError, 'unsupported_intents'],
    ['throw', SagaTurnError, 'handler_failed'],
    ['invalid', SagaTurnError, 'state_validation_failed']
  ] as const)('rejects %s handler output before writing', async (mode, errorType, code) => {
    const repository = new FakeTurnRepository();
    const { table } = await initialize(repository, `failure-${mode}`);
    repository.appendCalls.length = 0;
    const promise = processSagaSourceEvent(table, repository, sourceEvent({
      type: 'turn.order-paid.v1.event',
      payload: { orderId: 'order-1', mode },
      commitId: `source-${mode}`,
      eventId: `event-${mode}`
    }));
    await expect(promise).rejects.toMatchObject({ code });
    await expect(promise).rejects.toBeInstanceOf(errorType);
    expect(repository.appendCalls).toHaveLength(0);
  });

  it('reconciles a known deterministic turn before invoking its handler', async () => {
    const repository = new FakeTurnRepository();
    const { counters, table } = await initialize(repository, 'duplicate');
    counters.initial = 0;
    const result = await processSagaSourceEvent(table, repository, sourceEvent());
    expect(result[0]?.status).toBe('reconciled');
    expect(counters).toMatchObject({ initial: 0, start: 0, handler: 0 });
    expect(repository.appendCalls).toHaveLength(1);
  });

  it('fails incompatible deterministic commits with an integrity error', async () => {
    const repository = new FakeTurnRepository();
    const table = createTurnTable('integrity', createCounters());
    repository.forcedCommit = {
      streamId: 'wrong-stream',
      commitId: 'wrong-commit',
      commitSequence: 0,
      identity: { sourceTriggerId: 'wrong', sagaKey: 'wrong', instanceId: 'wrong', routeId: 'wrong' }
    };
    const promise = processSagaSourceEvent(table, repository, sourceEvent());
    await expect(promise).rejects.toBeInstanceOf(SagaTurnIntegrityError);
    await expect(promise).rejects.toMatchObject({ kind: 'integrity', retryable: false, code: 'incompatible_turn_commit' });
    expect(repository.appendCalls).toHaveLength(0);
  });

  it('fails start/on correlation disagreement before repository access', async () => {
    const repository = new FakeTurnRepository();
    const counters = createCounters();
    const definition = createTurnDefinition('correlation', counters, () => 'other-order');
    const table = compileSagaRoutes(
      [definition],
      createStartEventBindings({ definition, triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] })
    );
    await expect(processSagaSourceEvent(table, repository, sourceEvent())).rejects.toMatchObject({ code: 'route_resolution_failed' });
    expect(repository.findCalls).toHaveLength(0);
    expect(repository.loadCalls).toHaveLength(0);
    expect(repository.appendCalls).toHaveLength(0);
  });

  it('rejects non-serializable source data before repository access', async () => {
    const repository = new FakeTurnRepository();
    const table = createTurnTable('invalid-source', createCounters());
    const promise = processSagaSourceEvent(table, repository, sourceEvent({ metadata: { invalid: () => undefined } }));
    await expect(promise).rejects.toBeInstanceOf(SagaTurnPermanentError);
    await expect(promise).rejects.toMatchObject({ code: 'invalid_source_event' });
    expect(repository.findCalls).toHaveLength(0);
    expect(repository.loadCalls).toHaveLength(0);
    expect(repository.appendCalls).toHaveLength(0);
  });

  it('validates unknown repository events before projection or handler execution', async () => {
    const repository = new FakeTurnRepository();
    const { counters, table, outcome } = await initialize(repository, 'invalid-stored-event');
    if (!outcome) throw new Error('expected initialization outcome');
    repository.replaceEvents(outcome.instanceId, [{ type: 'saga.unknown.event', payload: {} }]);
    repository.appendCalls.length = 0;
    const promise = processSagaSourceEvent(table, repository, sourceEvent({
      type: 'turn.order-paid.v1.event', commitId: 'source-2', eventId: 'event-2'
    }));
    await expect(promise).rejects.toBeInstanceOf(SagaTurnIntegrityError);
    await expect(promise).rejects.toMatchObject({ code: 'unknown_stored_event' });
    expect(counters.handler).toBe(0);
    expect(repository.appendCalls).toHaveLength(0);
  });

  it('rejects malformed stored optional fields and replay ordering before handlers', async () => {
    const repository = new FakeTurnRepository();
    const { counters, table, outcome } = await initialize(repository, 'malformed-stored');
    if (!outcome) throw new Error('expected initialization outcome');
    const events = repository.appendCalls[0]?.events;
    if (!events) throw new Error('expected initialization events');
    const malformed = events.map((event) => {
      if (event.type !== 'saga.source_event_observed.event') return event;
      const payload = payloadOf(event);
      const record = payload.record;
      if (typeof record !== 'object' || record === null) throw new Error('expected source record');
      return { ...event, payload: { record: { ...record, sequence: 'not-a-number' } } };
    });
    repository.replaceEvents(outcome.instanceId, malformed);
    repository.appendCalls.length = 0;
    const promise = processSagaSourceEvent(table, repository, sourceEvent({
      type: 'turn.order-paid.v1.event', commitId: 'source-2', eventId: 'event-2'
    }));
    await expect(promise).rejects.toMatchObject({ code: 'invalid_stored_event', retryable: false });
    expect(counters.handler).toBe(0);
    expect(repository.appendCalls).toHaveLength(0);
  });

  it('rejects business state before creation and duplicate creation during replay', async () => {
    const repository = new FakeTurnRepository();
    const { table, outcome } = await initialize(repository, 'replay-order');
    if (!outcome) throw new Error('expected initialization outcome');
    const events = repository.appendCalls[0]?.events;
    if (!events || !events[0] || !events[1] || !events[2]) throw new Error('expected initialization events');
    repository.replaceEvents(outcome.instanceId, [events[2], events[0], events[1]]);
    const input = sourceEvent({ type: 'turn.order-paid.v1.event', commitId: 'source-2', eventId: 'event-2' });
    await expect(processSagaSourceEvent(table, repository, input)).rejects.toMatchObject({ code: 'invalid_replay_order' });
    repository.replaceEvents(outcome.instanceId, [events[0], events[0], events[1], events[2]]);
    await expect(processSagaSourceEvent(table, repository, input)).rejects.toMatchObject({ code: 'invalid_replay_order' });
  });

  it('fails closed when an existing instance uses another definition version', async () => {
    const repository = new FakeTurnRepository();
    const countersV1 = createCounters();
    const definitionV1 = createTurnDefinition('versioned', countersV1, undefined, 1);
    const tableV1 = compileSagaRoutes(
      [definitionV1],
      createStartEventBindings({ definition: definitionV1, triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] })
    );
    await processSagaSourceEvent(tableV1, repository, sourceEvent());
    const countersV2 = createCounters();
    const definitionV2 = createTurnDefinition('versioned', countersV2, undefined, 2);
    const tableV2 = compileSagaRoutes([definitionV2]);
    repository.appendCalls.length = 0;
    const promise = processSagaSourceEvent(tableV2, repository, sourceEvent({
      type: 'turn.order-paid.v1.event', commitId: 'source-v2', eventId: 'event-v2'
    }));
    await expect(promise).rejects.toBeInstanceOf(SagaTurnPermanentError);
    await expect(promise).rejects.toMatchObject({ code: 'definition_version_migration_unsupported', retryable: false });
    expect(countersV2.handler).toBe(0);
    expect(repository.appendCalls).toHaveLength(0);
  });

  it('fails closed when an existing stream has no authoritative business state', async () => {
    const repository = new FakeTurnRepository();
    const { table, outcome } = await initialize(repository, 'legacy');
    if (!outcome) throw new Error('expected initialization outcome');
    repository.removeBusinessState(outcome.instanceId);
    repository.appendCalls.length = 0;
    await expect(processSagaSourceEvent(table, repository, sourceEvent({
      type: 'turn.order-paid.v1.event', commitId: 'source-2', eventId: 'event-2'
    }))).rejects.toMatchObject({ code: 'legacy_business_state_missing' });
    expect(repository.appendCalls).toHaveLength(0);
  });
});
