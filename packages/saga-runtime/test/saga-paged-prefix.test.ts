import { describe, expect, it } from '@jest/globals';
import { hydrateSagaTurn } from '../src/turns/aggregateTurn';
import { processSagaSourceEvent } from '../src/turns/processSagaSource';
import { createCounters, createTurnTable, FakeTurnRepository, registrationOptions, sourceEvent } from './fixtures/turn-processor.fixture';

describe('bounded saga prefix replay', () => {
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
