import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createSaga } from '@redemeine/saga';
import { compileRegisteredSagaRoutes, registerSagaDefinition, type SagaRegistration } from '@redemeine/saga-runtime';
import type { SagaTurnAggregateEvent } from '@redemeine/saga-runtime';

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

const realRegistrations = new WeakMap<object, SagaRegistration<RealSagaState>>();

export function registrationForRealDefinition(definition: object): SagaRegistration<RealSagaState> {
  const registration = realRegistrations.get(definition);
  if (!registration) throw new TypeError('Missing real-stack executable registration');
  return registration;
}

function parseRealStartInput(value: unknown): { orderId: string } {
  if (typeof value !== 'object' || value === null || !('orderId' in value) || typeof value.orderId !== 'string') {
    throw new TypeError('Invalid real-stack start input');
  }
  return { orderId: value.orderId };
}

function parseRealState(value: unknown): RealSagaState {
  if (typeof value !== 'object' || value === null || !('count' in value) || typeof value.count !== 'number' ||
      !('seen' in value) || !Array.isArray(value.seen) || !value.seen.every((id: unknown) => typeof id === 'string') ||
      ('large' in value && typeof value.large !== 'string')) throw new TypeError('Invalid real-stack state');
  return { ...value, count: value.count, seen: value.seen };
}

export function parseRealEvent(value: unknown): SagaTurnAggregateEvent {
  if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' ||
      !('type' in value) || typeof value.type !== 'string' || !('payload' in value) ||
      ('aggregateType' in value && typeof value.aggregateType !== 'string') ||
      ('aggregateId' in value && typeof value.aggregateId !== 'string') ||
      ('sequence' in value && typeof value.sequence !== 'number') ||
      ('metadata' in value && (typeof value.metadata !== 'object' || value.metadata === null || Array.isArray(value.metadata)))) {
    throw new TypeError('Invalid real-stack event');
  }
  return { ...value, id: value.id, type: value.type, payload: value.payload };
}

export function createRealDefinition(name: string, counters: RealCounters, startWithCount = false) {
  const definition = createSaga<RealSagaState>({ identity: { namespace: 'real.stack', name, version: 1 } })
    .initialState((): RealSagaState => {
      counters.initial += 1;
      return { count: 0, seen: [] };
    })
    .start((state, input: { orderId: string }) => {
      counters.start += 1;
      if (startWithCount) state.count = input.orderId.length;
    })
    .correlateBy((input) => orderIdFrom({ payload: input }))
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
  realRegistrations.set(definition, registerSagaDefinition({ definition, pluginManifests: [],
    responseHandlerBindings: {}, parseStartInput: parseRealStartInput, parseState: parseRealState,
    parseOnEvent: parseRealEvent, canonicalCommandTypes: [] }));
  return definition;
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

export function orderIdFrom(value: unknown): string {
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
  if (event.payload.mode === 'intent') context.schedule('invalid-last', -1);
  if (event.payload.mode === 'large') state.large = 'x'.repeat(8 * 1024 * 1024 + 1);
  state.count += event.payload.amount ?? 1;
  state.seen.push(event.id);
}

export function createRealTable(name: string, counters: RealCounters, startWithCount = false) {
  const definition = createRealDefinition(name, counters, startWithCount);
  return {
    definition,
    table: compileRegisteredSagaRoutes([registrationForRealDefinition(definition)],
      [{ registration: registrationForRealDefinition(definition), triggerIndex: 0, eventTypes: ['real.order-placed.v1.event'] }])
  };
}

export function createFanoutTable(first: ReturnType<typeof createRealDefinition>, second: ReturnType<typeof createRealDefinition>) {
  return compileRegisteredSagaRoutes(
    [registrationForRealDefinition(first), registrationForRealDefinition(second)],
    [
      { registration: registrationForRealDefinition(first), triggerIndex: 0, eventTypes: ['real.order-placed.v1.event'] },
      { registration: registrationForRealDefinition(second), triggerIndex: 0, eventTypes: ['real.order-placed.v1.event'] }
    ]
  );
}
