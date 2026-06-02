import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  runSagaErrorHandler,
  runSagaHandler,
  runSagaResponseHandler,
  type SagaAggregateEventByName,
  type TErrorToken,
  type TResponseToken
} from '../src';

type FailureTestState = {
  attempts: number;
};

const FailureAggregate = {
  aggregateType: 'billing',
  pure: {
    eventProjectors: {
      charged: (_state: unknown, _event: { payload: { invoiceId: string } }) => undefined
    }
  },
  commandCreators: {}
} as const;

const FAILURE_HANDLER_METADATA = {
  sagaId: 'saga-failure-1',
  correlationId: 'corr-failure-1',
  causationId: 'cause-failure-1'
} as const;

describe('saga handler failure semantics', () => {
  it('propagates errors thrown by runSagaHandler handlers without returning an envelope', async () => {
    const thrown = new Error('saga handler failed');

    await expect(runSagaHandler(
      { attempts: 0 },
      {
        type: 'billing.charged.event',
        payload: { invoiceId: 'inv-1' }
      } as SagaAggregateEventByName<typeof FailureAggregate, 'charged'>,
      (state) => {
        state.attempts += 1;
        throw thrown;
      },
      FAILURE_HANDLER_METADATA
    )).rejects.toBe(thrown);
  });

  it('propagates errors thrown by runSagaResponseHandler handlers after token lookup succeeds', async () => {
    const thrown = new Error('response handler failed');
    const saga = createSaga<FailureTestState>({
      identity: { namespace: 'failure', name: 'response-handler', version: 1 }
    })
      .onResponses({
        'billing.charge.ok': (state) => {
          state.attempts += 1;
          throw thrown;
        }
      })
      .build();

    await expect(runSagaResponseHandler({
      definition: saga,
      state: { attempts: 0 },
      envelope: {
        token: 'billing.charge.ok' as TResponseToken<'billing.charge.ok'>,
        payload: { invoiceId: 'inv-1' },
        request: {
          plugin_key: 'billing',
          action_name: 'charge',
          sagaId: 'saga-failure-2',
          correlationId: 'corr-failure-2',
          causationId: 'cause-failure-2'
        }
      }
    })).rejects.toBe(thrown);
  });

  it('propagates errors thrown by runSagaErrorHandler handlers after token lookup succeeds', async () => {
    const thrown = new Error('error handler failed');
    const saga = createSaga<FailureTestState>({
      identity: { namespace: 'failure', name: 'error-handler', version: 1 }
    })
      .onErrors({
        'billing.charge.failed': (state) => {
          state.attempts += 1;
          throw thrown;
        }
      })
      .build();

    await expect(runSagaErrorHandler({
      definition: saga,
      state: { attempts: 0 },
      envelope: {
        token: 'billing.charge.failed' as TErrorToken<'billing.charge.failed'>,
        error: { code: 'declined' },
        request: {
          plugin_key: 'billing',
          action_name: 'charge',
          sagaId: 'saga-failure-3',
          correlationId: 'corr-failure-3',
          causationId: 'cause-failure-3'
        }
      }
    })).rejects.toBe(thrown);
  });
});
