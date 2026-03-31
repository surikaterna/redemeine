import { describe, expect, it } from '@jest/globals';
import { createSaga, executeSagaReducerOutputInReplay, type SagaReducerOutput } from '../../src/sagas';

type InvoiceCommandMap = {
  'invoice.create': { invoiceId: string; amount: number };
};

describe('createSaga fluent API + runtime command translation seam', () => {
  it('keeps fluent createSaga().on(...).build() usage intact while replay uses runtime translation seam', async () => {
    const saga = createSaga<InvoiceCommandMap>()
      .initialState(() => ({ invoiceId: 'inv-1', attempts: 0 }))
      .on('invoice', {
        created: ctx => ({
          state: { ...ctx.state, attempts: ctx.state.attempts + 1 },
          intents: [
            ctx.dispatch('invoice.create', {
              invoiceId: ctx.state.invoiceId,
              amount: 250
            })
          ]
        })
      })
      .build();

    const output = await saga.handlers[0].handlers.created({
      state: { invoiceId: 'inv-1', attempts: 0 },
      metadata: {
        sagaId: 'saga-1',
        correlationId: 'corr-1',
        causationId: 'cause-1'
      },
      dispatch: (command, payload, metadata) => ({
        type: 'dispatch',
        command,
        payload,
        metadata: {
          sagaId: metadata?.sagaId ?? 'saga-1',
          correlationId: metadata?.correlationId ?? 'corr-1',
          causationId: metadata?.causationId ?? 'cause-2'
        }
      }),
      schedule: (id, delay, metadata) => ({
        type: 'schedule',
        id,
        delay,
        metadata: {
          sagaId: metadata?.sagaId ?? 'saga-1',
          correlationId: metadata?.correlationId ?? 'corr-1',
          causationId: metadata?.causationId ?? 'cause-3'
        }
      }),
      cancelSchedule: (id, metadata) => ({
        type: 'cancel-schedule',
        id,
        metadata: {
          sagaId: metadata?.sagaId ?? 'saga-1',
          correlationId: metadata?.correlationId ?? 'corr-1',
          causationId: metadata?.causationId ?? 'cause-4'
        }
      }),
      runActivity: (name, closure, retryPolicy, metadata) => ({
        type: 'run-activity',
        name,
        closure,
        retryPolicy,
        metadata: {
          sagaId: metadata?.sagaId ?? 'saga-1',
          correlationId: metadata?.correlationId ?? 'corr-1',
          causationId: metadata?.causationId ?? 'cause-5'
        }
      })
    });

    const replay = await executeSagaReducerOutputInReplay(
      output as SagaReducerOutput<{ invoiceId: string; attempts: number }, InvoiceCommandMap>
    );

    expect(replay.state).toEqual({ invoiceId: 'inv-1', attempts: 1 });
    expect(replay.outcomes).toEqual([
      {
        intentType: 'dispatch',
        executed: false,
        reason: 'replay-mode-suppressed'
      }
    ]);
  });
});
