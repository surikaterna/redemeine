import { describe, expect, it, jest } from '@jest/globals';
import {
  BusinessStateValidationError,
  CorrelationNormalizationError,
  createSagaAggregate,
  isJsonSafeBusinessState,
  normalizeSagaAggregateState,
  type SagaAggregate,
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

function createInstance<TState>(aggregate: SagaAggregate<TState>) {
  const event = aggregate.process(
    aggregate.initialState,
    aggregate.commandCreators.createInstance({ id: 'instance-1', sagaType: 'commerce/checkout@v2', createdAt: recordedAt })
  )[0];
  if (!event) throw new Error('createInstance did not emit an event');
  return aggregate.apply(aggregate.initialState, event);
}

function expectValidationCode(execute: () => unknown, code: BusinessStateValidationError['code']): void {
  try {
    execute();
    throw new Error('expected business state validation failure');
  } catch (error) {
    if (!(error instanceof BusinessStateValidationError)) throw error;
    expect(error.code).toBe(code);
  }
}

describe('saga authoritative business state', () => {
  it('emits the versioned stable event shape and preserves generic typing', () => {
    const aggregate = createSagaAggregate<'saga', CheckoutState>({ aggregateName: 'saga' });
    const state = createInstance(aggregate);
    const command = aggregate.commandCreators.recordBusinessState(createStatePayload({ status: 'pending', attempts: 1 }));
    const event = aggregate.process(state, command)[0];
    if (!event) throw new Error('recordBusinessState did not emit an event');

    expect(command.type).toBe('saga.record_business_state.command');
    expect(event).toMatchObject({
      type: 'saga.business_state_recorded.event',
      payload: createStatePayload({ status: 'pending', attempts: 1 })
    });

    const projected: SagaAggregateState<CheckoutState> = aggregate.apply(state, event);
    expect(projected.businessState?.status).toBe('pending');
  });

  it('constrains command state generically while default unknown remains additive', () => {
    const typed = createSagaAggregate<'saga', CheckoutState>();
    typed.commandCreators.recordBusinessState(createStatePayload({ status: 'pending', attempts: 1 }));
    // @ts-expect-error attempts must remain a number through the generated command creator type
    typed.commandCreators.recordBusinessState({ ...createStatePayload({ status: 'pending', attempts: 1 }), state: { status: 'pending', attempts: 'wrong' } });

    const untyped = createSagaAggregate();
    untyped.commandCreators.recordBusinessState(createStatePayload({ status: 'custom', attempts: 3 }));
  });

  it('replays complete replacements with the last business-state event winning', () => {
    const aggregate = createSagaAggregate<'saga', CheckoutState>();
    let state = createInstance(aggregate);
    const first = aggregate.process(
      state,
      aggregate.commandCreators.recordBusinessState(createStatePayload({ status: 'pending', attempts: 1 }, 'trigger-1'))
    )[0];
    if (!first) throw new Error('first recordBusinessState did not emit an event');
    state = aggregate.apply(state, first);
    const second = aggregate.process(state, aggregate.commandCreators.recordBusinessState(createStatePayload({ status: 'paid', attempts: 2 }, 'trigger-2')))[0];
    if (!second) throw new Error('second recordBusinessState did not emit an event');
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
    const observed = aggregate.process(state, aggregate.commandCreators.observeSourceEvent({ eventType: 'orders.placed.event', observedAt: recordedAt }))[0];
    if (!observed) throw new Error('observeSourceEvent did not emit an event');
    const replayed = aggregate.apply(state, observed);

    expect(replayed.businessState).toBeNull();
    expect(replayed.sagaKey).toBeNull();
    expect(replayed.definitionVersion).toBeNull();
    expect(replayed.correlation).toBeNull();
    expect(replayed.totals.observedEvents).toBe(1);
  });

  it('keeps the pre-business-state SagaAggregateState shape source-compatible', () => {
    const legacy: SagaAggregateState = {
      id: 'legacy-1',
      sagaType: 'legacy',
      lifecycleState: 'active',
      createdAt: recordedAt,
      updatedAt: recordedAt,
      transitionVersion: 1,
      totals: { transitions: 0, observedEvents: 0, intents: 0, activities: 0 },
      recent: { transitions: [], events: [], intents: [], activities: [] }
    };
    expect(normalizeSagaAggregateState(legacy)).toMatchObject({ businessState: null, sagaKey: null });
  });

  it('rejects noncanonical or oversized correlations at the aggregate command boundary', () => {
    const aggregate = createSagaAggregate<'saga', CheckoutState>();
    const state = createInstance(aggregate);
    const processCorrelation = (value: string) =>
      aggregate.process(
        state,
        aggregate.commandCreators.recordBusinessState({ ...createStatePayload({ status: 'pending', attempts: 1 }), correlation: { type: 'string', value } })
      );
    expect(() => processCorrelation('Cafe\u0301')).toThrow(CorrelationNormalizationError);
    expect(() => processCorrelation('x'.repeat(513))).toThrow(CorrelationNormalizationError);
  });
});

describe('business state validation', () => {
  it('accepts JSON-safe primitives, arrays, plain objects, and repeated references', () => {
    const shared = { value: 1 };
    const nullPrototype: Record<string, unknown> = Object.create(null);
    nullPrototype.value = true;
    const values: unknown[] = [null, true, 'value', 42, [1, 'two', false], { nested: { ok: true } }, [shared, shared], nullPrototype];
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

    expectValidationCode(() => validateBusinessState(cyclic), 'cyclic_json_value');
  });

  it('rejects hostile depth and explicit depth/node limit violations without recursion overflow', () => {
    let deep: unknown = true;
    for (let index = 0; index < 20_000; index += 1) deep = { next: deep };
    expectValidationCode(() => validateBusinessState(deep), 'business_state_too_deep');
    expectValidationCode(() => validateBusinessState({ child: { value: true } }, { maxDepth: 1 }), 'business_state_too_deep');
    expectValidationCode(() => validateBusinessState([1, 2, 3], { maxNodes: 3 }), 'business_state_too_complex');
  });

  it('rejects huge sparse arrays and bounds large object traversal before stack growth', () => {
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    expectValidationCode(() => validateBusinessState(sparse), 'invalid_json_value');
    const largeObject = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`key-${index}`, index]));
    expectValidationCode(() => validateBusinessState(largeObject, { maxNodes: 500 }), 'business_state_too_complex');
  });

  it('rejects accessors without invoking them and classifies hostile proxy inspection', () => {
    let getterCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'unsafe';
      }
    });
    expectValidationCode(() => validateBusinessState(accessor), 'invalid_json_value');
    expect(getterCalls).toBe(0);

    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('blocked');
        }
      }
    );
    expectValidationCode(() => validateBusinessState(hostile), 'property_inspection_failed');
  });

  it('enforces a configurable UTF-8 encoded byte ceiling', () => {
    expect(() => validateBusinessState('é', { maxBytes: 4 })).not.toThrow();
    expect(() => validateBusinessState('é', { maxBytes: 3 })).toThrow(expect.objectContaining({ code: 'business_state_too_large' }));
    expect(() => validateBusinessState('\n', { maxBytes: 4 })).not.toThrow();
    expect(() => validateBusinessState('\n', { maxBytes: 3 })).toThrow(expect.objectContaining({ code: 'business_state_too_large' }));
    expect(() => validateBusinessState('😀', { maxBytes: 6 })).not.toThrow();
    expect(() => validateBusinessState('😀', { maxBytes: 5 })).toThrow(expect.objectContaining({ code: 'business_state_too_large' }));
  });

  it('rejects oversized scalar strings and keys before passing a full token to TextEncoder', () => {
    const oversized = 'x'.repeat(10_000);
    const encode = jest.spyOn(TextEncoder.prototype, 'encode');
    try {
      expectValidationCode(() => validateBusinessState(oversized, { maxBytes: 1_024 }), 'business_state_too_large');
      expect(encode).not.toHaveBeenCalled();
      expectValidationCode(() => validateBusinessState({ [oversized]: true }, { maxBytes: 1_024 }), 'business_state_too_large');
      const encodedInputLengths = encode.mock.calls.map(([input]) => input?.length ?? 0);
      expect(Math.max(...encodedInputLengths)).toBeLessThan(oversized.length);
    } finally {
      encode.mockRestore();
    }
  });
});
