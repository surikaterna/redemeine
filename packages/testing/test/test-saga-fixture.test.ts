import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  type CanonicalSagaIdentityInput,
  type SagaResponseHandlerTokenBindings
} from '@redemeine/saga';
import { testSaga } from '../src';

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

describe('testSaga fixture', () => {
  it('runs chain flow through event -> invokeResponse -> invokeError', async () => {
    const responseBindings = {
      'payment.capture.ok': {
        plugin_key: 'payments',
        action_name: 'capture',
        phase: 'response'
      },
      'payment.capture.failed': {
        plugin_key: 'payments',
        action_name: 'capture',
        phase: 'error'
      }
    } as const satisfies SagaResponseHandlerTokenBindings;

    const saga = createSaga<{ attempts: number; log: string[] }>({ identity: TEST_SAGA_CHAIN_IDENTITY })
      .initialState(() => ({ attempts: 0, log: [] as string[] }))
      .responseDefinitions(responseBindings)
      .on(PaymentAggregate, {
        started: (state, event, ctx) => {
          state.log.push(`started:${event.payload.id}`);
          ctx.emit({
            type: 'plugin-request',
            plugin_key: 'payments',
            action_name: 'capture',
            action_kind: 'request_response',
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
            type: 'plugin-request',
            plugin_key: 'payments',
            action_name: 'capture',
            action_kind: 'request_response',
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
    const responseBindings = {
      'payment.capture.ok': {
        plugin_key: 'payments',
        action_name: 'capture',
        phase: 'response'
      },
      'payment.capture.failed': {
        plugin_key: 'payments',
        action_name: 'capture',
        phase: 'error'
      }
    } as const satisfies SagaResponseHandlerTokenBindings;

    const saga = createSaga<{ seen: string[] }>({ identity: TEST_SAGA_FIFO_IDENTITY })
      .initialState(() => ({ seen: [] as string[] }))
      .responseDefinitions(responseBindings)
      .on(PaymentAggregate, {
        started: (state, event, ctx) => {
          state.seen.push(`event:${event.payload.id}`);
          ctx.emit({
            type: 'plugin-request',
            plugin_key: 'payments',
            action_name: 'capture',
            action_kind: 'request_response',
            execution_payload: { id: `${event.payload.id}-first` },
            routing_metadata: {
              response_handler_key: 'payment.capture.ok',
              error_handler_key: 'payment.capture.failed',
              handler_data: {}
            },
            metadata: ctx.metadata
          });

          ctx.emit({
            type: 'plugin-request',
            plugin_key: 'payments',
            action_name: 'capture',
            action_kind: 'request_response',
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
  });

  it('returns explicit deterministic failures for unknown token and empty queue', async () => {
    const saga = createSaga<{ touched: number }>({ identity: TEST_SAGA_FAILURES_IDENTITY })
      .initialState(() => ({ touched: 0 }))
      .responseDefinitions({
        'payment.capture.ok': {
          plugin_key: 'payments',
          action_name: 'capture',
          phase: 'response'
        },
        'payment.capture.failed': {
          plugin_key: 'payments',
          action_name: 'capture',
          phase: 'error'
        }
      })
      .build();

    const fixture = testSaga(saga);

    const unknownResponse = await fixture.invokeResponse('payment.unknown', 'x');
    expect(unknownResponse).toEqual({
      ok: false,
      reason: 'unknown_token',
      token: 'payment.unknown'
    });

    const emptyResponse = await fixture.invokeResponse('payment.capture.ok', 'x');
    expect(emptyResponse).toEqual({
      ok: false,
      reason: 'queue_empty',
      token: 'payment.capture.ok'
    });

    const unknownError = await fixture.invokeError('payment.unknown.error', 'x');
    expect(unknownError).toEqual({
      ok: false,
      reason: 'unknown_token',
      token: 'payment.unknown.error'
    });

    const emptyError = await fixture.invokeError('payment.capture.failed', 'x');
    expect(emptyError).toEqual({
      ok: false,
      reason: 'queue_empty',
      token: 'payment.capture.failed'
    });
  });
});
