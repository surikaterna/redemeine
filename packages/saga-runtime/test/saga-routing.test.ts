import { describe, expect, it } from '@jest/globals';
import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createSaga } from '@redemeine/saga';
import { compileSagaRoutes, createStartEventBindings, matchSagaRoutes, SagaRouteCompilationError, type SagaStartEventBinding } from '../src/index';

interface OrderState {
  orderId: string;
}

const orders = createAggregate('orders', { count: 0 })
  .events({
    placed: (state, _event: Event<{ orderId: string }>) => {
      state.count += 1;
    },
    paid: (state, _event: Event<{ orderId: string }>) => {
      state.count += 1;
    }
  })
  .overrideEventNames({ placed: 'commerce.order-placed.v1', paid: 'commerce.order-paid.v1' })
  .build();

function createDefinition(version = 1) {
  return createSaga<OrderState>({ identity: { namespace: 'commerce', name: 'checkout', version } })
    .initialState(() => ({ orderId: '' }))
    .start((state, input: { orderId: string }) => {
      state.orderId = input.orderId;
    })
    .correlateBy((input) => input.orderId)
    .triggeredBy({
      kind: 'domain-not-a-selector',
      toStartInput: (event: { payload: { orderId: string } }) => ({ orderId: event.payload.orderId })
    })
    .correlate(orders, () => 'order-42')
    .on(orders, {
      placed: (state, event) => {
        state.orderId = event.payload.orderId;
      },
      paid: (state, event) => {
        state.orderId = event.payload.orderId;
      }
    })
    .build();
}

function startBinding(definition: ReturnType<typeof createDefinition>): SagaStartEventBinding {
  return { definition, triggerIndex: 0, eventTypes: ['commerce.order-placed.v1'] };
}

describe('saga route compilation', () => {
  it('uses explicit start bindings and built aggregate event maps for exact matching', () => {
    const definition = createDefinition();
    const bindings = createStartEventBindings(startBinding(definition));
    const table = compileSagaRoutes([definition], bindings);
    const matched = matchSagaRoutes(table, {
      type: 'commerce.order-placed.v1',
      payload: { orderId: 'order-42' },
      partitionId: 'partition-1',
      streamId: 'orders-42',
      commitId: 'commit-1',
      eventIndex: 0,
      eventId: 'event-retained-1'
    });

    expect(matched.map(({ route }) => route.kind)).toEqual(['on', 'start']);
    expect(matched.every(({ route }) => route.eventType === 'commerce.order-placed.v1')).toBe(true);
    expect(matched.every(({ eventId }) => eventId === 'event-retained-1')).toBe(true);
    expect(
      matchSagaRoutes(table, {
        type: 'orders.placed.event',
        payload: {},
        partitionId: 'p',
        streamId: 's',
        commitId: 'c',
        eventIndex: 0,
        eventId: 'e'
      })
    ).toEqual([]);
  });

  it('sorts routes deterministically by exact event type and route identity', () => {
    const definition = createDefinition();
    const first = compileSagaRoutes([definition], [startBinding(definition)]).routes.map(({ routeId }) => routeId);
    const second = compileSagaRoutes([definition], [startBinding(definition)]).routes.map(({ routeId }) => routeId);
    expect(second).toEqual(first);
    expect(first).toEqual(['on:orders:paid:commerce.order-paid.v1', 'on:orders:placed:commerce.order-placed.v1', 'start:0:commerce.order-placed.v1']);
  });

  it('rejects duplicate active definition families across versions', () => {
    expectCompilationError(() => compileSagaRoutes([createDefinition(1), createDefinition(2)]), 'duplicate_active_definition');
  });

  it('validates start trigger indexes, exact types, active definitions, and duplicate registrations', () => {
    const definition = createDefinition();
    expectCompilationError(() => compileSagaRoutes([definition], [{ ...startBinding(definition), triggerIndex: 1 }]), 'invalid_start_binding');
    expectCompilationError(() => compileSagaRoutes([definition], [{ ...startBinding(definition), eventTypes: [] }]), 'invalid_start_binding');
    expectCompilationError(() => compileSagaRoutes([definition], [startBinding(createDefinition(2))]), 'invalid_start_binding');
    expectCompilationError(() => compileSagaRoutes([definition], [startBinding(definition), startBinding(definition)]), 'duplicate_start_binding');
  });

  it('rejects duplicate .on handler routes', () => {
    const definition = createSaga<OrderState>({ identity: { namespace: 'commerce', name: 'duplicate', version: 1 } })
      .initialState(() => ({ orderId: '' }))
      .correlate(orders, () => 'order-42')
      .on(orders, { placed: () => undefined })
      .on(orders, { placed: () => undefined })
      .build();
    expectCompilationError(() => compileSagaRoutes([definition]), 'duplicate_handler_route');
  });
});

function expectCompilationError(execute: () => unknown, code: SagaRouteCompilationError['code']): void {
  try {
    execute();
    throw new Error('expected route compilation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(SagaRouteCompilationError);
    expect((error as SagaRouteCompilationError).code).toBe(code);
  }
}
