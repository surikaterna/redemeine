import assert from 'node:assert/strict';
import { createAggregate, createContractFromAggregate } from '@redemeine/aggregate';
import { Contract, ContractError, type Event } from '@redemeine/kernel';
import { createMirage, extractState, extractUncommittedEvents, MirageCoreSymbol } from '@redemeine/mirage';
import { createProjection } from '@redemeine/projection';
import { createSaga } from '@redemeine/saga';
import { createTestDepot, testProjection, testSaga } from '@redemeine/testing';

const counter = createAggregate('counter', { id: '', total: 0 })
  .events({
    added: (state, event: Event<{ id: string; amount: number }>) => {
      state.id = event.payload.id;
      state.total += event.payload.amount;
    }
  })
  .commands((emit) => ({
    add: (_state, payload: { id: string; amount: number }) => emit.added(payload)
  }))
  .build();

const projection = createProjection('counter-view', (id: string) => ({ id, total: 0 }))
  .from(counter, {
    added: (state, event) => { state.total += event.payload.amount; }
  })
  .build();

function checkIdentityAndReplay() {
  const contract = createContractFromAggregate(counter, {});
  assert.ok(contract instanceof Contract);
  assert.throws(() => contract.validateCommand('missing', {}), ContractError);

  const mirage = createMirage(counter, 'counter-1');
  assert.ok(Reflect.get(mirage, MirageCoreSymbol));
  mirage.add({ id: 'counter-1', amount: 2 });
  const events = extractUncommittedEvents(mirage);
  assert.equal(events.length, 1);
  assert.deepEqual(extractState(mirage), { id: 'counter-1', total: 2 });
  const replayed = events.reduce(counter.apply, counter.initialState);
  assert.deepEqual(replayed, { id: 'counter-1', total: 2 });
  return events;
}

async function checkDepotIsolation() {
  const first = createTestDepot({ aggregates: [counter], projections: [projection] });
  const second = createTestDepot({ aggregates: [counter], projections: [projection] });
  await first.dispatch(counter.commandCreators.add({ id: 'same-id', amount: 2 }));
  await first.dispatch(counter.commandCreators.add({ id: 'same-id', amount: 3 }));
  await second.dispatch(counter.commandCreators.add({ id: 'same-id', amount: 9 }));
  await Promise.all([first.waitForIdle(), second.waitForIdle()]);
  assert.deepEqual(await first.projections.get(projection, 'same-id'), { id: 'same-id', total: 5 });
  assert.deepEqual(await second.projections.get(projection, 'same-id'), { id: 'same-id', total: 9 });
}

async function checkSaga() {
  const saga = createSaga<{ total: number }>({
    identity: { namespace: 'release.smoke', name: 'counter', version: 1 }
  })
    .initialState(() => ({ total: 0 }))
    .on(counter, {
      added: (state, event) => { state.total += event.payload.amount; }
    })
    .build();
  const fixture = testSaga(saga);
  await fixture.receiveEvent({
    type: 'counter.added.event', aggregateType: 'counter', aggregateId: 'counter-1',
    payload: { id: 'counter-1', amount: 7 }
  });
  fixture.expectState({ total: 7 }).expectIntents([]);
}

const events = checkIdentityAndReplay();
const hydrated = await createMirage(counter, 'counter-1', { events });
assert.deepEqual(extractState(hydrated), { id: 'counter-1', total: 2 });
const projected = testProjection(projection).withState({ id: 'counter-1', total: 0 });
projected.applyEvent({
  aggregateType: 'counter', aggregateId: 'counter-1', type: 'counter.added.event',
  payload: { id: 'counter-1', amount: 4 }, sequence: 1, timestamp: '2026-10-06T00:00:00Z'
});
assert.deepEqual(projected.getState(), { id: 'counter-1', total: 4 });
await checkDepotIsolation();
await checkSaga();
console.log('PASS six-package contract identity, mirage replay, projection, depot isolation, saga');
