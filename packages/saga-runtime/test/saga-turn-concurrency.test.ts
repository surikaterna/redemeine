import { describe, expect, it } from '@jest/globals';
import {
  compileSagaRoutes,
  createStartEventBindings,
  processSagaSourceEvent,
  processSagaSourceEvents,
  SagaTurnTransientError
} from '../src/index';
import {
  createCounters,
  createTurnDefinition,
  createTurnTable,
  FakeTurnRepository,
  sourceEvent
} from './fixtures/turn-processor.fixture';

function persistedCount(request: { events: readonly { type: string; payload: unknown }[] }): number {
  const event = request.events.find(({ type }) => type === 'saga.business_state_recorded.event');
  if (!event || typeof event.payload !== 'object' || event.payload === null || !('state' in event.payload)) throw new Error('missing state event');
  const state = event.payload.state;
  if (typeof state !== 'object' || state === null || !('count' in state) || typeof state.count !== 'number') throw new Error('missing count');
  return state.count;
}

async function initialize(repository: FakeTurnRepository, name: string) {
  const counters = createCounters();
  const table = createTurnTable(name, counters);
  await processSagaSourceEvent(table, repository, sourceEvent());
  repository.appendCalls.length = 0;
  counters.handler = 0;
  return { counters, table };
}

function paidSource(commitId = 'paid-commit') {
  return sourceEvent({
    type: 'turn.order-paid.v1.event',
    payload: { orderId: 'order-1', amount: 1 },
    commitId,
    eventId: `${commitId}-event`,
    eventIndex: 1,
    createDateTime: '2026-09-21T11:00:00.000Z'
  });
}

describe('saga turn OCC and ordered fanout', () => {
  it('commits one concurrent duplicate and reconciles the other', async () => {
    const repository = new FakeTurnRepository();
    const { table } = await initialize(repository, 'concurrent-duplicate');
    const [first, second] = await Promise.all([
      processSagaSourceEvent(table, repository, paidSource()),
      processSagaSourceEvent(table, repository, paidSource())
    ]);
    expect([first[0]?.status, second[0]?.status].sort()).toEqual(['committed', 'reconciled']);
    expect(repository.appendCalls).toHaveLength(2);
    expect(repository.appendCalls[0]?.commitId).toBe(repository.appendCalls[1]?.commitId);
    expect(repository.appendCalls[0]?.events).toEqual(repository.appendCalls[1]?.events);
  });

  it('derives stable command metadata without rewriting source metadata or aliasing another source', async () => {
    const repository = new FakeTurnRepository();
    const { table } = await initialize(repository, 'stable-envelopes');
    const source = paidSource();
    await processSagaSourceEvent(table, repository, source);
    const first = repository.appendCalls[0]!;
    repository.appendCalls.length = 0;
    await processSagaSourceEvent(table, repository, paidSource('other-paid-commit'));
    const second = repository.appendCalls[0]!;
    expect(first.events[0]?.metadata).toMatchObject({ command: { type: expect.any(String), id: expect.any(String) } });
    expect(first.events[0]?.metadata).not.toEqual(second.events[0]?.metadata);
    expect(first.events[0]?.payload).toMatchObject({ record: { metadata: { tenant: 'tenant-1' } } });
    expect(first.events[0]?.headers).toBeUndefined();
  });

  it('reconciles after a conflict when the same turn appeared without rerunning', async () => {
    const repository = new FakeTurnRepository();
    const { counters, table } = await initialize(repository, 'conflict-duplicate');
    let first = true;
    repository.beforeAppend = (request, target) => {
      if (!first) return null;
      first = false;
      target.commit(request);
      return { status: 'conflict' };
    };
    const outcome = await processSagaSourceEvent(table, repository, paidSource());
    expect(outcome[0]?.status).toBe('reconciled');
    expect(counters.handler).toBe(1);
    expect(repository.appendCalls).toHaveLength(1);
  });

  it('reloads winner state and reruns a pure handler after a distinct OCC winner', async () => {
    const repository = new FakeTurnRepository();
    const { counters, table } = await initialize(repository, 'distinct-winner');
    let first = true;
    repository.beforeAppend = (request, target) => {
      if (!first) return null;
      first = false;
      target.replaceBusinessState(request, 10);
      return { status: 'conflict' };
    };
    const outcome = await processSagaSourceEvent(table, repository, paidSource());
    expect(outcome[0]?.status).toBe('committed');
    expect(counters.handler).toBe(2);
    expect(repository.appendCalls).toHaveLength(2);
    expect(persistedCount(repository.appendCalls[1])).toBe(11);
  });

  it('raises a transient error when the bounded conflict retry limit is exhausted', async () => {
    const repository = new FakeTurnRepository();
    const { table } = await initialize(repository, 'retry-bound');
    repository.beforeAppend = () => ({ status: 'conflict' });
    const promise = processSagaSourceEvent(table, repository, paidSource(), { maxConflictRetries: 2 });
    await expect(promise).rejects.toBeInstanceOf(SagaTurnTransientError);
    await expect(promise).rejects.toMatchObject({ kind: 'transient', retryable: true, code: 'conflict_retry_exhausted' });
    expect(repository.appendCalls).toHaveLength(3);
  });

  it('preserves source-event and deterministic definition order across fanout', async () => {
    const repository = new FakeTurnRepository();
    const firstCounters = createCounters();
    const secondCounters = createCounters();
    const first = createTurnDefinition('fanout-a', firstCounters);
    const second = createTurnDefinition('fanout-b', secondCounters);
    const table = compileSagaRoutes(
      [second, first],
      createStartEventBindings(
        { definition: second, triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] },
        { definition: first, triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] }
      )
    );
    const outcomes = await processSagaSourceEvents(table, repository, [
      sourceEvent(),
      sourceEvent({ commitId: 'source-2', eventId: 'event-2', eventIndex: 1, createDateTime: '2026-09-21T12:00:00.000Z' })
    ]);
    expect(outcomes).toHaveLength(4);
    expect(outcomes.map(({ sagaKey }) => sagaKey)).toEqual([
      first.sagaKey, second.sagaKey, first.sagaKey, second.sagaKey
    ]);
    expect(repository.appendCalls).toHaveLength(4);
    expect(repository.appendCalls.slice(0, 2).every(({ events }) => events.length === 3)).toBe(true);
    expect(repository.appendCalls.slice(2).every(({ events }) => events.length === 2)).toBe(true);
    expect(firstCounters).toMatchObject({ initial: 1, start: 0, handler: 1 });
    expect(secondCounters).toMatchObject({ initial: 1, start: 0, handler: 1 });
  });
});
