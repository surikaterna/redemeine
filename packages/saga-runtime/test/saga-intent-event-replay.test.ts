import { createSagaAggregate } from '../src/SagaAggregate';
import { createWireIntent, decodeIntent } from '../src/intentWire';
import { hydrateSagaTurn, SagaTurnReplaySession } from '../src/turns/aggregateTurn';
import { assertSagaTurnIntentBudget } from '../src/turns/commitMaterial';
import type { SagaTurnStoredCommit } from '../src/turns/contracts';
import { createCounters, createTurnTable, FakeTurnRepository, registrationOptions, sourceEvent } from './fixtures/turn-processor.fixture';
import { processSagaSourceEvent } from '../src/turns/processSagaSource';
import { deriveTurnCommitId } from '../src/identity/deterministicIds';

async function fixture() {
  const repository = new FakeTurnRepository();
  const table = createTurnTable('intent-replay', createCounters());
  await processSagaSourceEvent(table, repository, sourceEvent(), registrationOptions(table));
  const request = repository.appendCalls[0]!;
  const snapshot = await repository.load(request.streamId);
  const commits: SagaTurnStoredCommit[] = [];
  for await (const commit of snapshot.commits) commits.push(commit);
  const origin = { sagaKey: request.identity.sagaKey, correlation: { type: 'string' as const, value: 'order-1' },
    sourceId: request.identity.sourceTriggerId, routeId: request.identity.routeId, ordinal: 0 };
  const metadata = { sagaId: request.streamId, correlationId: JSON.stringify(['string', 'order-1']), causationId: request.identity.sourceTriggerId };
  return { commits, request, origin, metadata };
}

function withEvents(commit: SagaTurnStoredCommit, extra: readonly { type: string; payload: unknown }[]): SagaTurnStoredCommit {
  return { ...commit, events: [...commit.events, ...extra.map((event, index) => ({ ...event,
    id: `intent:${index}`, version: commit.events[0]!.version + commit.events.length + index }))] };
}

describe('versioned authoritative saga intent grammar', () => {
  it('replays historical four-event initial and complete initial plus existing turn across page boundaries', async () => {
    const { commits, request, origin, metadata } = await fixture();
    const aggregate = createSagaAggregate();
    const intent = createWireIntent(origin, metadata, { kind: 'schedule', timerId: 'later', dueAt: '2026-09-21T10:00:01.000Z' }, []);
    const extra = [
      { type: aggregate.types!.events.intentRecorded, payload: { schemaVersion: 1, intent } },
      { type: aggregate.types!.events.timerFactRecorded, payload: { schemaVersion: 1, fact: {
        intentId: intent.intentId, action: 'schedule', timerId: 'later', dueAt: intent.dueAt } } }
    ];
    const first = withEvents(commits[0]!, extra);
    const session = new SagaTurnReplaySession(request.streamId);
    session.apply(first);
    expect(session.finish(1).state.totals.intents).toBe(1);
    const historic = new SagaTurnReplaySession(request.streamId);
    historic.apply(commits[0]!);
    expect(historic.finish(1).state.totals.intents).toBe(0);
    const nextIdentity = { ...first.identity, sourceTriggerId: 'next-source' };
    const next: SagaTurnStoredCommit = { ...first, commitSequence: 1, identity: nextIdentity,
      commitId: deriveTurnCommitId(nextIdentity), events: [
      { ...commits[0]!.events[2]!, version: first.events.length },
      { ...commits[0]!.events[3]!, version: first.events.length + 1, payload: {
        ...(commits[0]!.events[3]!.payload as object), sourceTriggerId: 'next-source' } },
      ...extra.map((event, index) => ({ ...event, version: first.events.length + 2 + index, id: `next:${index}`,
        payload: index === 0 ? { schemaVersion: 1, intent: createWireIntent({ ...origin, sourceId: 'next-source' },
          { ...metadata, causationId: 'next-source' }, { kind: 'schedule', timerId: 'later', dueAt: intent.dueAt }, []) } : event.payload }))
    ] };
    const nextIntent = (next.events[2]!.payload as { intent: typeof intent }).intent;
    const completeNext = { ...next, events: next.events.map((event, index) => index !== 3 ? event : {
      ...event, payload: { schemaVersion: 1, fact: { action: 'schedule', intentId: nextIntent.intentId,
        timerId: 'later', dueAt: intent.dueAt } } }) };
    const paged = { streamId: request.streamId, nextCommitSequence: 2, commits: (async function* () { yield first; yield completeNext; })() };
    await expect(hydrateSagaTurn(paged, request.streamId)).resolves.toMatchObject({ state: { totals: { intents: 2 } } });
  });

  it('rejects missing, extra, reordered and unknown-version facts at physical boundaries', async () => {
    const { commits, request, origin, metadata } = await fixture();
    const types = createSagaAggregate().types!.events;
    const intent = createWireIntent(origin, metadata, { kind: 'cancelSchedule', timerId: 'later' }, []);
    const wire = { type: types.intentRecorded, payload: { schemaVersion: 1, intent } };
    const fact = { type: types.timerFactRecorded, payload: { schemaVersion: 1, fact: {
      action: 'cancelSchedule', timerId: 'later', intentId: intent.intentId } } };
    for (const extra of [[wire], [fact], [fact, wire], [wire, fact, fact], [wire, { ...fact, payload: {
      ...fact.payload, schemaVersion: 2 } }], [wire, { ...fact, payload: { ...fact.payload, fact: {
      ...fact.payload.fact, timerId: 'wrong' } } }], [{ ...wire, payload: { ...wire.payload, intent: {
      ...intent, origin: { ...origin, ordinal: 1 } } } }, fact]]) {
      const session = new SagaTurnReplaySession(request.streamId);
      expect(() => session.apply(withEvents(commits[0]!, extra))).toThrow();
    }
    expect(request.events).toHaveLength(4);
  });

  it('refuses a corrupted stored intent before invoking a handler or writing another turn', async () => {
    const repository = new FakeTurnRepository();
    const counters = createCounters();
    const table = createTurnTable('intent-corruption', counters);
    const source = sourceEvent();
    await processSagaSourceEvent(table, repository, source, registrationOptions(table));
    const initial = repository.appendCalls[0]!;
    repository.replaceEvents(initial.streamId, [...initial.events, {
      type: 'saga.intent_recorded.event', payload: { schemaVersion: 2, intent: {} }
    }]);
    const next = sourceEvent({ eventId: 'next', commitId: 'next', eventIndex: 1 });
    await expect(processSagaSourceEvent(table, repository, next, registrationOptions(table)))
      .rejects.toMatchObject({ code: 'invalid_stored_event', retryable: false });
    expect(repository.appendCalls).toHaveLength(1);
    expect(counters.handler).toBe(0);
  });

  it('budgets each wire independently of a business state exceeding 64 KiB', async () => {
    const { commits, request, origin, metadata } = await fixture();
    const registry = [{ plugin_key: 'core', actions: [], commandTypes: ['example.command'] }];
    const base = createWireIntent(origin, metadata, { kind: 'dispatch', command: 'example.command', payload: { text: '' } }, registry);
    const make = (bytes: number) => ({ type: 'saga.intent_recorded.event', payload: { schemaVersion: 1, intent: {
      ...base, payload: { text: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(base))) } } } });
    expect(Buffer.byteLength(JSON.stringify((make(65536).payload).intent))).toBe(65536);
    expect(() => decodeIntent(make(65536).payload.intent, registry)).not.toThrow();
    expect(() => decodeIntent(make(65537).payload.intent, registry)).toThrow();
    expect(() => assertSagaTurnIntentBudget([make(65536)])).not.toThrow();
    expect(() => assertSagaTurnIntentBudget([make(65537)])).toThrow();
    const state = { ...commits[0]!.events[3]!, payload: { ...(commits[0]!.events[3]!.payload as object),
      state: { data: 'x'.repeat(70000) } } };
    const session = new SagaTurnReplaySession(request.streamId);
    expect(() => session.apply({ ...commits[0]!, events: [...commits[0]!.events.slice(0, 3), state] })).not.toThrow();
  });
});
