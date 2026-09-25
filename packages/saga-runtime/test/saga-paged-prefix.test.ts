import { describe, expect, it } from '@jest/globals';
import { hydrateSagaTurn } from '../src/turns/aggregateTurn';
import { processSagaSourceEvent } from '../src/turns/processSagaSource';
import { createCounters, createTurnTable, FakeTurnRepository, sourceEvent } from './fixtures/turn-processor.fixture';

describe('bounded saga prefix replay', () => {
  it('projects the original prefix inside a complete stored commit without changing its event versions', async () => {
    const repository = new FakeTurnRepository();
    const started = await processSagaSourceEvent(createTurnTable('prefix', createCounters()), repository, sourceEvent());
    const id = started[0]!.instanceId;
    const empty = await hydrateSagaTurn(await repository.load(id), id, { commitSequence: 0, eventOffset: 0 });
    expect(empty.state.id).toBeNull();
    const created = await hydrateSagaTurn(await repository.load(id), id, { commitSequence: 0, eventOffset: 1 });
    expect(created.state.id).toBe(id);
    expect(created.state.businessState).toBeNull();
    const authoritative = await hydrateSagaTurn(await repository.load(id), id, { commitSequence: 0, eventOffset: 3 });
    expect(authoritative.state.businessState).toEqual({ count: 0 });
    await expect(hydrateSagaTurn(await repository.load(id), id, { commitSequence: 0, eventOffset: 4 }))
      .rejects.toMatchObject({ code: 'invalid_event_version' });
  });
});
