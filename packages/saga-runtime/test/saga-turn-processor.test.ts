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
    expect(counters).toEqual({ initial: 1, start: 0, handler: 0 });
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
    expect(counters).toEqual({ initial: 1, start: 0, handler: 0 });
  });

  it('uses initiation for new start+on events and on handling for existing instances', async () => {
    const repository = new FakeTurnRepository();
    const { counters, table } = await initialize(repository, 'branching');
    expect(counters.handler).toBe(0);
    await processSagaSourceEvent(table, repository, sourceEvent({ commitId: 'source-commit-2', eventId: 'event-2' }));
    expect(counters.handler).toBe(1);
    expect(counters.start).toBe(0);
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
    expect(counters).toEqual({ initial: 0, start: 0, handler: 0 });
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
    await expect(processSagaSourceEvent(table, repository, sourceEvent())).rejects.toBeInstanceOf(SagaTurnIntegrityError);
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
