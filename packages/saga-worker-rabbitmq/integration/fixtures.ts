import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createSaga } from '@redemeine/saga';
import { compileSagaRoutes, createStartEventBindings } from '@redemeine/saga-runtime';

export interface RealSagaState {
  count: number;
  seen: string[];
  large?: string;
}

export interface RealPayload {
  orderId: string;
  amount?: number;
  mode?: 'intent' | 'large';
}

export interface RealCounters {
  initial: number;
  start: number;
  handlers: Map<string, number>;
}

export const realOrders = createAggregate('real-orders', { seen: 0 })
  .events({
    placed: (state, _event: Event<RealPayload>) => {
      state.seen += 1;
    },
    paid: (state, _event: Event<RealPayload>) => {
      state.seen += 1;
    },
    adjusted: (state, _event: Event<RealPayload>) => {
      state.seen += 1;
    }
  })
  .overrideEventNames({
    placed: 'real.order-placed.v1.event',
    paid: 'real.order-paid.v1.event',
    adjusted: 'real.order-adjusted.v1.event'
  })
  .build();

export function createCounters(): RealCounters {
  return { initial: 0, start: 0, handlers: new Map() };
}

export function createRealDefinition(name: string, counters: RealCounters) {
  return createSaga<unknown>({ identity: { namespace: 'real.stack', name, version: 1 } })
    .initialState((): unknown => {
      counters.initial += 1;
      return { count: 0, seen: [] };
    })
    .start((_input: { orderId: string }) => {
      counters.start += 1;
    })
    .correlateBy((input) => input.orderId)
    .triggeredBy({
      kind: 'domain',
      toStartInput: (event: { payload: RealPayload }) => ({ orderId: event.payload.orderId })
    })
    .correlate(realOrders, (event) => orderIdFrom(event))
    .on(realOrders, {
      placed: async (state, event, context) => applyEvent(requireState(state), event, context, counters),
      paid: async (state, event, context) => applyEvent(requireState(state), event, context, counters),
      adjusted: async (state, event, context) => applyEvent(requireState(state), event, context, counters)
    })
    .build();
}

function requireState(value: unknown): RealSagaState {
  if (typeof value !== 'object' || value === null || !('count' in value) || typeof value.count !== 'number') {
    throw new Error('real saga state count is invalid');
  }
  if (!('seen' in value) || !Array.isArray(value.seen) || value.seen.some((entry) => typeof entry !== 'string')) {
    throw new Error('real saga state seen list is invalid');
  }
  return value as RealSagaState;
}

function orderIdFrom(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('payload' in value)) throw new Error('event payload is required');
  const payload = value.payload;
  if (typeof payload !== 'object' || payload === null || !('orderId' in payload) || typeof payload.orderId !== 'string') {
    throw new Error('event orderId is required');
  }
  return payload.orderId;
}

function applyEvent(
  state: RealSagaState,
  event: { id?: string; payload: RealPayload },
  context: { schedule(id: string, delay: number): unknown },
  counters: RealCounters
): void {
  if (!event.id) throw new Error('event id is required');
  counters.handlers.set(event.id, (counters.handlers.get(event.id) ?? 0) + 1);
  if (event.payload.mode === 'intent') context.schedule('unsupported', 1);
  if (event.payload.mode === 'large') state.large = 'x'.repeat(8 * 1024 * 1024 + 1);
  state.count += event.payload.amount ?? 1;
  state.seen.push(event.id);
}

export function createRealTable(name: string, counters: RealCounters) {
  const definition = createRealDefinition(name, counters);
  return {
    definition,
    table: compileSagaRoutes([definition], createStartEventBindings({ definition, triggerIndex: 0, eventTypes: ['real.order-placed.v1.event'] }))
  };
}

export function createFanoutTable(first: ReturnType<typeof createRealDefinition>, second: ReturnType<typeof createRealDefinition>) {
  return compileSagaRoutes(
    [first, second],
    createStartEventBindings(
      { definition: first, triggerIndex: 0, eventTypes: ['real.order-placed.v1.event'] },
      { definition: second, triggerIndex: 0, eventTypes: ['real.order-placed.v1.event'] }
    )
  );
}
