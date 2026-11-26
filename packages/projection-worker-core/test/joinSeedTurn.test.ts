import { expect, jest, test } from '@jest/globals';
import { joinInitializer } from '@redemeine/projection-runtime-core';
import { bindJoinSeedReader } from '../src/joinSeedReaders';
import { JoinSeedTurn } from '../src/joinSeedTurn';

test('all seed suspensions share the deadline measured from the start of the turn', async () => {
  jest.useFakeTimers();
  try {
    const binding = joinInitializer({ aggregateType: 'Order', initialState: { value: 0 } }, { from: 'snapshot' });
    let cancelled = false;
    const reader = bindJoinSeedReader(binding, { seedGeneration: 'one', policy: 'bestEffort', async readOne(id, signal) {
      signal.addEventListener('abort', () => { cancelled = true; });
      if (id === 'two') return new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return { state: { value: 1 }, provenance: { aggregateType: 'Order', aggregateId: id, documentId: id,
        from: 'snapshot', seedName: 'Order', seedGeneration: 'one', position: { kind: 'unknown' } } };
    } });
    const turn = new JoinSeedTurn([reader], performance.now());
    await jest.advanceTimersByTimeAsync(1_000); // routing/discovery
    const first = turn.load([{ key: 'one', aggregateId: 'one', reader }]);
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(first).resolves.toBeUndefined();
    const second = turn.load([{ key: 'two', aggregateId: 'two', reader }]);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toMatchObject({ status: 'transient' });
    expect(cancelled).toBe(true);
    expect([...turn.loaded.keys()]).toEqual(['one']);
  } finally { jest.useRealTimers(); }
});

test('a prospective overflow neither calls the provider nor refunds already consumed reads', async () => {
  const binding = joinInitializer({ aggregateType: 'Order', initialState: { value: 0 } }, { from: 'snapshot' });
  const readOne = jest.fn(async (id: string) => ({ state: { value: 1 }, provenance: {
    aggregateType: 'Order', aggregateId: id, documentId: id, from: 'snapshot' as const,
    seedName: 'Order', seedGeneration: 'one', position: { kind: 'unknown' as const }
  } }));
  const reader = bindJoinSeedReader(binding, { seedGeneration: 'one', policy: 'bestEffort', readOne });
  const turn = new JoinSeedTurn([reader], performance.now());
  const inputs = Array.from({ length: 65 }, (_, index) => ({ key: `${index}`, aggregateId: `${index}`, reader }));
  await expect(turn.load(inputs.slice(0, 1))).resolves.toBeUndefined();
  await expect(turn.load(inputs.slice(1))).resolves.toMatchObject({ phase: 'planned_limit' });
  expect(readOne).toHaveBeenCalledTimes(1);
  await expect(turn.load(inputs.slice(1, 64))).resolves.toBeUndefined();
  await expect(turn.load(inputs.slice(64))).resolves.toMatchObject({ phase: 'planned_limit' });
  expect(readOne).toHaveBeenCalledTimes(64);
});
