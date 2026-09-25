import { describe, expect, it, jest } from '@jest/globals';
import { createSagaTurnAggregateEvent } from '../src/turns/aggregateEvent';
import { foldSagaTurn } from '../src/turns/originalTurnProof';
import { processSagaSourceEvent } from '../src/turns/processSagaSource';
import { matchSagaTurnRouteGroups, resolveSagaTurnRouteGroup } from '../src/turns/routePlanning';
import { createCounters, createTurnTable, FakeTurnRepository, registrationOptions, sourceEvent } from './fixtures/turn-processor.fixture';

const enabled = process.env.SAGA_AGGREGATE_MILLION_STRESS === '1';

(enabled ? describe : describe.skip)('lazy million-commit SagaAggregate fold', () => {
  it('retains one generated row, one target, and bounded aggregate states', async () => {
    jest.setTimeout(4 * 60 * 60 * 1000);
    const repository = new FakeTurnRepository();
    const table = createTurnTable('million-fold', createCounters());
    const source = sourceEvent();
    const started = await processSagaSourceEvent(table, repository, source, registrationOptions(table));
    const id = started[0]!.instanceId;
    const first = (await (await repository.load(id)).commits[Symbol.asyncIterator]().next()).value;
    if (!first) throw new Error('missing first commit');
    const event = createSagaTurnAggregateEvent(source);
    const group = matchSagaTurnRouteGroups(table, source, event)[0];
    if (!group) throw new Error('missing route');
    const resolved = resolveSagaTurnRouteGroup(group, source, event);
    const total = Number(process.env.SAGA_AGGREGATE_STRESS_COMMITS ?? 1_000_000);
    if (!Number.isSafeInteger(total) || total < 2 || total > 1_000_000) throw new Error('Invalid aggregate stress commit count');
    let generated = 0;
    let retained = 0;
    let peak = 0;
    const result = await foldSagaTurn({ streamId: id, nextCommitSequence: total, commits: (async function* () {
      for (let sequence = 0; sequence < total; sequence += 1) {
        const commit = sequence === 0 ? first : { ...first, commitId: `unrelated-${sequence}`, commitSequence: sequence,
          events: first.events.slice(2).map((stored, offset) => ({ ...stored,
            version: 4 + (sequence - 1) * 2 + offset })) };
        generated += 1;
        retained += 1;
        peak = Math.max(peak, retained);
        yield commit;
        retained -= 1;
      }
    })() }, resolved);
    expect(generated).toBe(total);
    expect(peak).toBe(1);
    expect(result.hydrated.state.totals.observedEvents).toBe(total);
    expect(result.nextEventVersion).toBe(4 + (total - 1) * 2);
    expect(result.target?.stored.commitSequence).toBe(0);
    const stateBytes = Buffer.byteLength(JSON.stringify(result.hydrated.state));
    const prefixBytes = Buffer.byteLength(JSON.stringify(result.target?.original.state));
    const candidateBytes = Buffer.byteLength(JSON.stringify(result.target?.stored));
    expect(stateBytes + prefixBytes + candidateBytes).toBeLessThan(36 * 1024 * 1024);
    console.info(JSON.stringify({ generated, peakLiveYieldedRows: peak, stateBytes, prefixBytes, candidateBytes,
      nextEventVersion: result.nextEventVersion }));
  });
});
