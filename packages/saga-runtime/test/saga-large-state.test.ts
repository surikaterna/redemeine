import { describe, expect, it } from '@jest/globals';
import { createSaga } from '@redemeine/saga';
import { compileSagaRoutes, createStartEventBindings } from '../src/routing';
import { processSagaSourceEvent } from '../src/turns/processSagaSource';
import { hydrateSagaTurn } from '../src/turns/aggregateTurn';
import { FakeTurnRepository, orders, registrationOptions, sourceEvent } from './fixtures/turn-processor.fixture';

function largeTable(initialBytes: number, nextBytes: number) {
  const definition = createSaga<{ blob: string; count: number }>({ identity: { namespace: 'turns', name: 'large', version: 1 } })
    .initialState(() => ({ blob: 'x'.repeat(initialBytes), count: 0 }))
    .start(() => undefined)
    .correlateBy((input: { orderId: string }) => input.orderId)
    .triggeredBy({ kind: 'domain', toStartInput: (event: { payload: { orderId: string } }) => event.payload })
    .correlate(orders, (event) => event.payload.orderId)
    .on(orders, { placed: (state) => { state.blob = 'y'.repeat(nextBytes); state.count += 1; } })
    .build();
  return compileSagaRoutes([definition], createStartEventBindings({ definition, triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] }));
}

describe('saga business state budgets', () => {
  it('replays and reconciles 1.5 MiB initial and on states without an implicit 1 MiB cap', async () => {
    const table = largeTable(1_500_000, 1_500_001);
    const repository = new FakeTurnRepository();
    const options = registrationOptions(table);
    const first = sourceEvent();
    const second = sourceEvent({ commitId: 'other', eventId: 'other-event' });
    const started = await processSagaSourceEvent(table, repository, first, options);
    const updated = await processSagaSourceEvent(table, repository, second, options);
    const snapshot = await repository.load(started[0]!.instanceId);
    const hydrated = await hydrateSagaTurn(snapshot, started[0]!.instanceId);
    expect(hydrated.state.businessState).toMatchObject({ count: 1, blob: 'y'.repeat(1_500_001) });
    expect(updated[0]?.status).toBe('committed');
    expect((await processSagaSourceEvent(table, repository, first, options))[0]?.status).toBe('reconciled');
    expect((await processSagaSourceEvent(table, repository, second, options))[0]?.status).toBe('reconciled');
    expect(repository.appendCalls).toHaveLength(2);
  });

  it('rejects oversized initial and on business state before either append', async () => {
    const repository = new FakeTurnRepository();
    const over = 8 * 1024 * 1024 + 1;
    const tooLargeInitial = largeTable(over, 0);
    await expect(processSagaSourceEvent(tooLargeInitial, repository, sourceEvent(), registrationOptions(tooLargeInitial)))
      .rejects.toMatchObject({ code: 'saga_state_too_large', retryable: false });
    expect(repository.appendCalls).toHaveLength(0);
    const tooLargeOn = largeTable(10, over);
    const options = registrationOptions(tooLargeOn);
    await processSagaSourceEvent(tooLargeOn, repository, sourceEvent(), options);
    await expect(processSagaSourceEvent(tooLargeOn, repository, sourceEvent({ commitId: 'other', eventId: 'other-event' }), options))
      .rejects.toMatchObject({ code: 'saga_state_too_large', retryable: false });
    expect(repository.appendCalls).toHaveLength(1);
  });

  it('accepts business state just under the existing 8 MiB JSON budget', async () => {
    const table = largeTable(8 * 1024 * 1024 - 256, 0);
    const repository = new FakeTurnRepository();
    const outcome = await processSagaSourceEvent(table, repository, sourceEvent(), registrationOptions(table));
    expect(outcome[0]?.status).toBe('committed');
    expect(repository.appendCalls).toHaveLength(1);
    expect((await hydrateSagaTurn(await repository.load(outcome[0]!.instanceId), outcome[0]!.instanceId)).state.businessState)
      .toMatchObject({ count: 0, blob: 'x'.repeat(8 * 1024 * 1024 - 256) });
  });

  it('refuses a historical over-8 MiB business state before handler or duplicate ACK', async () => {
    const table = largeTable(10, 10);
    const repository = new FakeTurnRepository();
    const options = registrationOptions(table);
    const started = await processSagaSourceEvent(table, repository, sourceEvent(), options);
    const original = repository.appendCalls[0]!;
    repository.replaceEvents(started[0]!.instanceId, original.events.map((event) => event.type === 'saga.business_state_recorded.event'
      ? { ...event, payload: { ...(typeof event.payload === 'object' && event.payload !== null ? event.payload : {}),
        state: { blob: 'x'.repeat(8 * 1024 * 1024 + 1), count: 0 } } } : event));
    await expect(processSagaSourceEvent(table, repository, sourceEvent(), options))
      .rejects.toMatchObject({ code: 'invalid_stored_event', retryable: false });
    expect(repository.appendCalls).toHaveLength(1);
  });
});
