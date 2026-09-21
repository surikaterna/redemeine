import { describe, expect, it } from '@jest/globals';
import {
  BusinessStateValidationError,
  createSagaAggregate,
  isJsonSafeBusinessState,
  type SagaAggregateState,
  validateBusinessState
} from '../src/createSagaAggregate';

interface CheckoutState {
  readonly status: string;
  readonly attempts: number;
}

const recordedAt = '2026-09-21T12:00:00.000Z';
const correlation = { type: 'string', value: 'order-42' } as const;

function createStatePayload(state: CheckoutState, sourceTriggerId = 'trigger-1') {
  return {
    schemaVersion: 1 as const,
    sagaKey: 'commerce/checkout',
    definitionVersion: 2,
    correlation,
    sourceTriggerId,
    state,
    recordedAt
  };
}

function createInstance<TState>(aggregate: ReturnType<typeof createSagaAggregate<string, TState>>) {
  const event = aggregate.process(
    aggregate.initialState,
    aggregate.commandCreators.createInstance({ id: 'instance-1', sagaType: 'commerce/checkout@v2', createdAt: recordedAt })
  )[0]!;
  return aggregate.apply(aggregate.initialState, event);
}

describe('saga authoritative business state', () => {
  it('emits the versioned stable event shape and preserves generic typing', () => {
    const aggregate = createSagaAggregate<'saga', CheckoutState>({ aggregateName: 'saga' });
    const state = createInstance(aggregate);
    const command = aggregate.commandCreators.recordBusinessState(createStatePayload({ status: 'pending', attempts: 1 }));
    const event = aggregate.process(state, command)[0]!;

    expect(command.type).toBe('saga.record_business_state.command');
    expect(event).toMatchObject({
      type: 'saga.business_state_recorded.event',
      payload: createStatePayload({ status: 'pending', attempts: 1 })
    });

    const projected: SagaAggregateState<CheckoutState> = aggregate.apply(state, event);
    expect(projected.businessState?.status).toBe('pending');
  });

  it('replays complete replacements with the last business-state event winning', () => {
    const aggregate = createSagaAggregate<'saga', CheckoutState>();
    let state = createInstance(aggregate);
    const first = aggregate.process(
      state,
      aggregate.commandCreators.recordBusinessState(createStatePayload({ status: 'pending', attempts: 1 }, 'trigger-1'))
    )[0]!;
    state = aggregate.apply(state, first);
    const second = aggregate.process(
      state,
      aggregate.commandCreators.recordBusinessState(createStatePayload({ status: 'paid', attempts: 2 }, 'trigger-2'))
    )[0]!;
    state = aggregate.apply(state, second);

    expect(state.businessState).toEqual({ status: 'paid', attempts: 2 });
    expect(state.sagaKey).toBe('commerce/checkout');
    expect(state.definitionVersion).toBe(2);
    expect(state.correlation).toEqual(correlation);
    expect(state.transitionVersion).toBe(3);
  });

  it('replays legacy lifecycle-only streams with null authoritative state', () => {
    const aggregate = createSagaAggregate<'saga', CheckoutState>();
    const state = createInstance(aggregate);
    const observed = aggregate.process(state, aggregate.commandCreators.observeSourceEvent({ eventType: 'orders.placed.event', observedAt: recordedAt }))[0]!;
    const replayed = aggregate.apply(state, observed);

    expect(replayed.businessState).toBeNull();
    expect(replayed.sagaKey).toBeNull();
    expect(replayed.definitionVersion).toBeNull();
    expect(replayed.correlation).toBeNull();
    expect(replayed.totals.observedEvents).toBe(1);
  });
});

describe('business state validation', () => {
  it('accepts JSON-safe primitives, arrays, plain objects, and repeated references', () => {
    const shared = { value: 1 };
    const values: unknown[] = [null, true, 'value', 42, [1, 'two', false], { nested: { ok: true } }, [shared, shared]];
    for (const value of values) {
      expect(isJsonSafeBusinessState(value)).toBe(true);
    }
  });

  it.each([undefined, 1n, () => undefined, Symbol('value'), Number.NaN, Number.POSITIVE_INFINITY, new Date(), new Map(), new Set(), new (class State {})()])(
    'rejects unsupported value %#',
    (value) => {
      expect(isJsonSafeBusinessState(value)).toBe(false);
    }
  );

  it('rejects nested unsupported values and cycles', () => {
    expect(() => validateBusinessState({ invalid: undefined })).toThrow(BusinessStateValidationError);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    try {
      validateBusinessState(cyclic);
      throw new Error('expected cycle rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessStateValidationError);
      expect((error as BusinessStateValidationError).code).toBe('cyclic_json_value');
    }
  });

  it('enforces a configurable UTF-8 encoded byte ceiling', () => {
    expect(() => validateBusinessState('é', { maxBytes: 4 })).not.toThrow();
    expect(() => validateBusinessState('é', { maxBytes: 3 })).toThrow(expect.objectContaining({ code: 'business_state_too_large' }));
  });
});
