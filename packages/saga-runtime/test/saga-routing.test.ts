import { describe, expect, it, jest } from '@jest/globals';
import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createSaga } from '@redemeine/saga';
import {
  assertMatchingSagaCorrelations,
  compileSagaRoutes,
  createStartEventBindings,
  matchSagaRoutes,
  normalizeSagaCorrelation,
  SagaRouteCompilationError,
  type SagaStartEventBinding
} from '../src/index';

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

const ambiguousOrders = createAggregate('ambiguous-orders', { count: 0 })
  .events({
    placed: (state, _event: Event<{ orderId: string }>) => {
      state.count += 1;
    },
    accepted: (state, _event: Event<{ orderId: string }>) => {
      state.count += 1;
    }
  })
  .overrideEventNames({ placed: 'commerce.same-event.v1', accepted: 'commerce.same-event.v1' })
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

function createTwoTriggerDefinition() {
  return createSaga<OrderState>({ identity: { namespace: 'commerce', name: 'multi-trigger', version: 1 } })
    .initialState(() => ({ orderId: '' }))
    .start((state, input: { orderId: string }) => {
      state.orderId = input.orderId;
    })
    .correlateBy((input) => input.orderId)
    .triggeredBy({ kind: 'first', toStartInput: (event: { payload: { orderId: string } }) => ({ orderId: event.payload.orderId }) })
    .triggeredBy({ kind: 'second', toStartInput: (event: { payload: { orderId: string } }) => ({ orderId: event.payload.orderId }) })
    .correlate(orders, () => 'order-42')
    .on(orders, { placed: () => undefined })
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

    expect(matched.map(({ route }) => route.kind)).toEqual(['start', 'on']);
    expect(assertMatchingSagaCorrelations(normalizeSagaCorrelation('order-42'), normalizeSagaCorrelation('order-42'))).toEqual({
      type: 'string',
      value: 'order-42'
    });
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
    const first = compileSagaRoutes([definition], [startBinding(definition)]).routes.map(({ eventType, routeId }) => ({ eventType, routeId }));
    const localeCompare = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('locale-dependent ordering used');
    });
    let second: typeof first;
    try {
      second = compileSagaRoutes([definition], [startBinding(definition)]).routes.map(({ eventType, routeId }) => ({ eventType, routeId }));
    } finally {
      localeCompare.mockRestore();
    }
    expect(second).toEqual(first);
    expect(first.map(({ eventType }) => eventType)).toEqual(['commerce.order-paid.v1', 'commerce.order-placed.v1', 'commerce.order-placed.v1']);
  });

  it('rejects duplicate active definition families across versions', () => {
    expectCompilationError(() => compileSagaRoutes([createDefinition(1), createDefinition(2)]), 'duplicate_active_definition');
  });

  it('compiles different route identities for separately active definition versions', () => {
    const routeFor = (version: number) => compileSagaRoutes([createDefinition(version)]).routes.find((route) => route.eventType === 'commerce.order-placed.v1');
    const routeV1 = routeFor(1);
    const routeV2 = routeFor(2);
    if (!routeV1 || !routeV2) throw new Error('expected placed routes');
    expect(routeV1.definitionVersion).toBe(1);
    expect(routeV2.definitionVersion).toBe(2);
    expect(routeV1.routeId).not.toBe(routeV2.routeId);
  });

  it('validates start trigger indexes, exact types, active definitions, and duplicate registrations', () => {
    const definition = createDefinition();
    expectCompilationError(() => compileSagaRoutes([definition], [{ ...startBinding(definition), triggerIndex: 1 }]), 'invalid_start_binding');
    expectCompilationError(() => compileSagaRoutes([definition], [{ ...startBinding(definition), eventTypes: [] }]), 'invalid_start_binding');
    expectCompilationError(() => compileSagaRoutes([definition], [startBinding(createDefinition(2))]), 'invalid_start_binding');
    expectCompilationError(() => compileSagaRoutes([definition], [startBinding(definition), startBinding(definition)]), 'duplicate_start_binding');
  });

  it('rejects duplicate canonical start event types across different trigger indexes', () => {
    const definition = createTwoTriggerDefinition();
    expectCompilationError(
      () =>
        compileSagaRoutes(
          [definition],
          [
            { definition, triggerIndex: 0, eventTypes: ['commerce.order-placed.v1'] },
            { definition, triggerIndex: 1, eventTypes: ['commerce.order-placed.v1'] }
          ]
        ),
      'duplicate_start_binding'
    );
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

  it('rejects distinct handler keys that resolve to one canonical wire event type', () => {
    const definition = createSaga<OrderState>({ identity: { namespace: 'commerce', name: 'ambiguous', version: 1 } })
      .initialState(() => ({ orderId: '' }))
      .correlate(ambiguousOrders, () => 'order-42')
      .on(ambiguousOrders, { placed: () => undefined, accepted: () => undefined })
      .build();
    expectCompilationError(() => compileSagaRoutes([definition]), 'duplicate_handler_route');
  });
});

function expectCompilationError(execute: () => unknown, code: SagaRouteCompilationError['code']): void {
  try {
    execute();
    throw new Error('expected route compilation failure');
  } catch (error) {
    if (!(error instanceof SagaRouteCompilationError)) throw error;
    expect(error.code).toBe(code);
  }
}
