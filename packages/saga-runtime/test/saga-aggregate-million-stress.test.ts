import { describe, expect, it, jest } from '@jest/globals';
import { createSagaTurnAggregateEvent } from '../src/turns/aggregateEvent';
import { foldSagaTurn } from '../src/turns/originalTurnProof';
import { processSagaSourceEvent } from '../src/turns/processSagaSource';
import { matchSagaTurnRouteGroups, resolveSagaTurnRouteGroup } from '../src/turns/routePlanning';
import { createCounters, createTurnTable, FakeTurnRepository, registrationOptions, sourceEvent } from './fixtures/turn-processor.fixture';

const enabled = process.env.SAGA_AGGREGATE_MILLION_STRESS === '1';

(enabled ? describe : describe.skip)('lazy paged SagaAggregate fold', () => {
  it('accounts for one bounded page, one target, and bounded aggregate states', async () => {
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
    let peakPageCount = 0;
    let peakPageBytes = 0;
    const result = await foldSagaTurn({ streamId: id, nextCommitSequence: total, commits: (async function* () {
      for (let start = 0; start < total; start += 64) {
        const page = [];
        let pageBytes = 0;
        for (let sequence = start; sequence < Math.min(start + 64, total); sequence += 1) {
          const commit = sequence === 0 ? first : { ...first, commitId: `unrelated-${sequence}`, commitSequence: sequence,
            events: first.events.slice(2).map((stored, offset) => ({ ...stored,
              version: 4 + (sequence - 1) * 2 + offset })) };
          page.push(commit);
          generated += 1;
          pageBytes += Buffer.byteLength(JSON.stringify(commit));
        }
        peakPageCount = Math.max(peakPageCount, page.length);
        peakPageBytes = Math.max(peakPageBytes, pageBytes);
        yield* page;
      }
    })() }, resolved);
    expect(generated).toBe(total);
    expect(peakPageCount).toBe(64);
    expect(peakPageBytes).toBeLessThan(12 * 1024 * 1024);
    expect(result.hydrated.state.totals.observedEvents).toBe(total);
    expect(result.nextEventVersion).toBe(4 + (total - 1) * 2);
    expect(result.target?.stored.commitSequence).toBe(0);
    const stateBytes = Buffer.byteLength(JSON.stringify(result.hydrated.state));
    const prefixBytes = Buffer.byteLength(JSON.stringify(result.target?.original.state));
    const candidateBytes = Buffer.byteLength(JSON.stringify(result.target?.stored));
    const peakAccountedBytes = peakPageBytes + stateBytes + prefixBytes + candidateBytes;
    expect(peakAccountedBytes).toBeLessThan(48 * 1024 * 1024);
    console.info(JSON.stringify({ generated, peakPageCount, peakPageBytes, stateBytes, prefixBytes, candidateBytes,
      peakAccountedBytes, nextEventVersion: result.nextEventVersion }));
  });
});
