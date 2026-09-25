import { describe, expect, it } from '@jest/globals';
import { hydrateSagaTurn } from '../src/turns/aggregateTurn';
import { foldSagaTurn } from '../src/turns/originalTurnProof';
import { resolveSagaTurnRouteGroup } from '../src/turns/routePlanning';
import { createSagaTurnAggregateEvent } from '../src/turns/aggregateEvent';
import { matchSagaTurnRouteGroups } from '../src/turns/routePlanning';
import { processSagaSourceEvent } from '../src/turns/processSagaSource';
import { createCounters, createTurnTable, FakeTurnRepository, registrationOptions, sourceEvent } from './fixtures/turn-processor.fixture';

describe('bounded saga prefix replay', () => {
  it('folds beyond 1024 complete commits and retains the original start prefix', async () => {
    const repository = new FakeTurnRepository();
    const table = createTurnTable('long-fold', createCounters());
    const source = sourceEvent();
    const started = await processSagaSourceEvent(table, repository, source, registrationOptions(table));
    const id = started[0]!.instanceId;
    const snapshot = await repository.load(id);
    const iterator = snapshot.commits[Symbol.asyncIterator]();
    const first = (await iterator.next()).value;
    if (!first) throw new Error('missing initial commit');
    const event = createSagaTurnAggregateEvent(source);
    const group = matchSagaTurnRouteGroups(table, source, event)[0];
    if (!group) throw new Error('missing route');
    const resolved = resolveSagaTurnRouteGroup(group, source, event);
    const count = 1026;
    const fold = await foldSagaTurn({ streamId: id, nextCommitSequence: count, commits: (async function* () {
      yield first;
      for (let sequence = 1; sequence < count; sequence += 1) {
        yield { ...first, commitId: `unrelated-${sequence}`, commitSequence: sequence,
          events: first.events.slice(2).map((stored, offset) => ({ ...stored, version: 4 + (sequence - 1) * 2 + offset })) };
      }
    })() }, resolved);
    expect(fold.nextEventVersion).toBe(4 + (count - 1) * 2);
    expect(fold.target?.firstEventVersion).toBe(0);
    expect(fold.target?.original.state.id).toBeNull();
    expect(fold.hydrated.state.totals.observedEvents).toBe(count);
  });
  it('rejects oversized historical aggregate windows before capturing a later target', async () => {
    const repository = new FakeTurnRepository();
    const table = createTurnTable('oversized-fold', createCounters());
    const source = sourceEvent();
    const started = await processSagaSourceEvent(table, repository, source, registrationOptions(table));
    const id = started[0]!.instanceId;
    const snapshot = await repository.load(id);
    const first = (await snapshot.commits[Symbol.asyncIterator]().next()).value;
    if (!first) throw new Error('missing initial commit');
    const event = createSagaTurnAggregateEvent(source);
    const group = matchSagaTurnRouteGroups(table, source, event)[0];
    if (!group) throw new Error('missing route');
    const resolved = resolveSagaTurnRouteGroup(group, source, event);
    const inflated = { ...first.events[2]!, payload: { record: { eventType: source.type,
      observedAt: source.createDateTime, payload: { content: 'x'.repeat(60_000) } } } };
    await expect(foldSagaTurn({ streamId: id, nextCommitSequence: 22, commits: (async function* () {
      yield first;
      for (let sequence = 1; sequence < 22; sequence += 1) {
        yield { ...first, commitId: `other-${sequence}`, commitSequence: sequence,
          events: [inflated, first.events[3]!].map((stored, offset) => ({ ...stored, version: 4 + (sequence - 1) * 2 + offset })) };
      }
    })() }, resolved)).rejects.toMatchObject({ code: 'saga_state_too_large', retryable: false });
    expect(repository.appendCalls).toHaveLength(1);
  });
  it('projects the original prefix inside a complete stored commit without changing its event versions', async () => {
    const repository = new FakeTurnRepository();
    const table = createTurnTable('prefix', createCounters());
    const started = await processSagaSourceEvent(table, repository, sourceEvent(), registrationOptions(table));
    const id = started[0]!.instanceId;
    const empty = await hydrateSagaTurn(await repository.load(id), id, { commitSequence: 0, eventOffset: 0 });
    expect(empty.state.id).toBeNull();
    const created = await hydrateSagaTurn(await repository.load(id), id, { commitSequence: 0, eventOffset: 1 });
    expect(created.state.id).toBe(id);
    expect(created.state.businessState).toBeNull();
    const authoritative = await hydrateSagaTurn(await repository.load(id), id, { commitSequence: 0, eventOffset: 4 });
    expect(authoritative.state.businessState).toEqual({ count: 0 });
    await expect(hydrateSagaTurn(await repository.load(id), id, { commitSequence: 0, eventOffset: 5 }))
      .rejects.toMatchObject({ code: 'invalid_event_version' });
    const snapshot = await repository.load(id);
    const commits = [];
    for await (const commit of snapshot.commits) commits.push(commit);
    const original = commits[0];
    if (!original) throw new Error('missing first commit');
    const split = { streamId: id, nextCommitSequence: 2, commits: (async function* () {
      yield { ...original, events: original.events.slice(0, 2) };
      yield { ...original, commitSequence: 1, events: original.events.slice(2) };
    })() };
    await expect(hydrateSagaTurn(split, id)).rejects.toMatchObject({ code: 'invalid_stored_event', retryable: false });
  });
});
