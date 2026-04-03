import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  type CanonicalSagaIdentityInput
} from '@redemeine/saga';
import { testSaga, type TestSagaFixture } from '../src';

const PaymentAggregate = {
  __aggregateType: 'payment',
  pure: {
    eventProjectors: {
      started: (_state: unknown, _event: { payload: { id: string } }) => undefined
    }
  },
  commandCreators: {
    'payment.capture': (id: string) => ({
      type: 'payment.capture',
      payload: { id }
    })
  }
} as const;

const TEST_SAGA_CHAIN_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'test.saga',
  name: 'chain',
  version: 1
};

const TEST_SAGA_FIFO_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'test.saga',
  name: 'fifo',
  version: 1
};

const TEST_SAGA_FAILURES_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'test.saga',
  name: 'failures',
  version: 1
};

const responseBindings = {
  'payment.capture.ok': { phase: 'response' as const },
  'payment.capture.failed': { phase: 'error' as const }
};

describe('testSaga fixture', () => {
  it('runs chain flow through event -> invokeResponse -> invokeError', async () => {
    const saga = createSaga<{ attempts: number; log: string[] }>({ identity: TEST_SAGA_CHAIN_IDENTITY })
      .initialState(() => ({ attempts: 0, log: [] as string[] }))
      .on(PaymentAggregate, {
        started: (state, event, ctx) => {
          state.log.push(`started:${event.payload.id}`);
          ctx.emit({
            type: 'plugin-intent',
            plugin_key: 'payments',
            action_name: 'capture',
            interaction: 'request_response',
            execution_payload: { id: event.payload.id },
            routing_metadata: {
              response_handler_key: 'payment.capture.ok',
              error_handler_key: 'payment.capture.failed',
              handler_data: { from: 'event' }
            },
            metadata: ctx.metadata
          });
        }
      })
      .onResponses({
        'payment.capture.ok': (state, response, ctx) => {
          state.attempts += 1;
          state.log.push(`ok:${String(response.payload)}`);
          ctx.emit({
            type: 'plugin-intent',
            plugin_key: 'payments',
            action_name: 'capture',
            interaction: 'request_response',
            execution_payload: { id: 'retry-1' },
            routing_metadata: {
              response_handler_key: 'payment.capture.ok',
              error_handler_key: 'payment.capture.failed',
              handler_data: { from: 'response' }
            },
            metadata: ctx.metadata
          });
        }
      })
      .onErrors({
        'payment.capture.failed': (state, error) => {
          state.attempts += 1;
          state.log.push(`error:${String(error.error)}`);
        }
      })
      .build();

    const fixture = testSaga(saga).withState({ attempts: 0, log: [] as string[] });

    await fixture.receiveEvent({
      type: 'started',
      payload: { id: 'p-1' },
      aggregateType: 'payment',
      metadata: {
        sagaId: 'saga-1',
        correlationId: 'corr-1',
        causationId: 'cause-1'
      }
    });

    const responseResult = await fixture.invokeResponse('payment.capture.ok', 'captured');
    expect(responseResult.ok).toBe(true);

    const errorResult = await fixture.invokeError('payment.capture.failed', 'declined');
    expect(errorResult.ok).toBe(true);

    fixture.expectState((state) => {
      expect(state).toEqual({
        attempts: 2,
        log: ['started:p-1', 'ok:captured', 'error:declined']
      });
    });

    fixture.expectIntents((intents) => {
      expect(intents).toEqual([]);
    });
  });

  it('dequeues plugin requests FIFO per token', async () => {
    const saga = createSaga<{ seen: string[] }>({ identity: TEST_SAGA_FIFO_IDENTITY })
      .initialState(() => ({ seen: [] as string[] }))
      .on(PaymentAggregate, {
        started: (state, event, ctx) => {
          state.seen.push(`event:${event.payload.id}`);
          ctx.emit({
            type: 'plugin-intent',
            plugin_key: 'payments',
            action_name: 'capture',
            interaction: 'request_response',
            execution_payload: { id: `${event.payload.id}-first` },
            routing_metadata: {
              response_handler_key: 'payment.capture.ok',
              error_handler_key: 'payment.capture.failed',
              handler_data: {}
            },
            metadata: ctx.metadata
          });

          ctx.emit({
            type: 'plugin-intent',
            plugin_key: 'payments',
            action_name: 'capture',
            interaction: 'request_response',
            execution_payload: { id: `${event.payload.id}-second` },
            routing_metadata: {
              response_handler_key: 'payment.capture.ok',
              error_handler_key: 'payment.capture.failed',
              handler_data: {}
            },
            metadata: ctx.metadata
          });
        }
      })
      .onResponses({
        'payment.capture.ok': (state, response) => {
          state.seen.push(`response:${String(response.payload)}`);
        }
      })
      .build();

    const fixture = testSaga(saga);

    await fixture.receiveEvent({
      type: 'started',
      payload: { id: 'p-2' },
      aggregateType: 'payment',
      metadata: {
        sagaId: 'saga-2',
        correlationId: 'corr-2',
        causationId: 'cause-2'
      }
    });

    const first = await fixture.invokeResponse('payment.capture.ok', 'first');
    const second = await fixture.invokeResponse('payment.capture.ok', 'second');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    fixture.expectState({
      seen: ['event:p-2', 'response:first', 'response:second']
    });

    // Compile-time phase safety assertions (token misuse must fail).
    if (false) {
      const typedFixture = null as unknown as TestSagaFixture<{ seen: string[] }, readonly [], typeof responseBindings>;
      // @ts-expect-error invokeResponse only accepts response-phase tokens
      void typedFixture.invokeResponse('payment.capture.failed', 'x');
      // @ts-expect-error invokeError only accepts error-phase tokens
      void typedFixture.invokeError('payment.capture.ok', 'x');
    }
  });

  it('returns explicit deterministic failures for unknown token, queue empty, and handler failures', async () => {
    const saga = createSaga<{ touched: number }>({ identity: TEST_SAGA_FAILURES_IDENTITY })
      .initialState(() => ({ touched: 0 }))
      .onResponses({
        'payment.capture.ok': () => undefined
      })
      .onErrors({
        'payment.capture.failed': () => undefined
      })
      .on(PaymentAggregate, {
        started: (_state, event, ctx) => {
          ctx.emit({
            type: 'plugin-intent',
            plugin_key: 'payments',
            action_name: 'capture',
            interaction: 'request_response',
            execution_payload: { id: event.payload.id },
            routing_metadata: {
              response_handler_key: 'payment.capture.ok',
              error_handler_key: 'payment.capture.failed',
              handler_data: { from: 'failure-test' }
            },
            metadata: ctx.metadata
          });
        }
      })
      .build();

    const runtimeHandlerGaps = saga as unknown as {
      responseHandlers: Record<string, unknown>;
      errorHandlers: Record<string, unknown>;
    };
    runtimeHandlerGaps.responseHandlers['payment.capture.ok'] = undefined;
    runtimeHandlerGaps.errorHandlers['payment.capture.failed'] = undefined;

    const fixture = testSaga(saga);

    const unknownResponse = await fixture.invokeResponse('payment.unknown' as any, 'x');
    expect(unknownResponse).toEqual({
      ok: false,
      reason: 'unknown_token',
      token: 'payment.unknown'
    });

    await fixture.receiveEvent({
      type: 'started',
      payload: { id: 'p-3' },
      aggregateType: 'payment',
      metadata: {
        sagaId: 'saga-3',
        correlationId: 'corr-3',
        causationId: 'cause-3'
      }
    });

    const responseHandlerFailure = await fixture.invokeResponse('payment.capture.ok', 'x');
    expect(responseHandlerFailure).toEqual({
      ok: false,
      reason: 'handler_not_registered',
      token: 'payment.capture.ok'
    });

    const emptyResponse = await fixture.invokeResponse('payment.capture.ok', 'x');
    expect(emptyResponse).toEqual({
      ok: false,
      reason: 'queue_empty',
      token: 'payment.capture.ok'
    });

    const unknownError = await fixture.invokeError('payment.unknown.error' as any, 'x');
    expect(unknownError).toEqual({
      ok: false,
      reason: 'unknown_token',
      token: 'payment.unknown.error'
    });

    await fixture.receiveEvent({
      type: 'started',
      payload: { id: 'p-4' },
      aggregateType: 'payment',
      metadata: {
        sagaId: 'saga-4',
        correlationId: 'corr-4',
        causationId: 'cause-4'
      }
    });

    const errorHandlerFailure = await fixture.invokeError('payment.capture.failed', 'x');
    expect(errorHandlerFailure).toEqual({
      ok: false,
      reason: 'handler_not_registered',
      token: 'payment.capture.failed'
    });

    const emptyError = await fixture.invokeError('payment.capture.failed', 'x');
    expect(emptyError).toEqual({
      ok: false,
      reason: 'queue_empty',
      token: 'payment.capture.failed'
    });
  });
});
