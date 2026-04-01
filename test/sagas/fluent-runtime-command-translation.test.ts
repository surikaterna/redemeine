import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  createSagaDispatchContext,
  executeSagaReducerOutputInReplay,
  type SagaReducerOutput
} from '../../src/sagas/internal/runtime';

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

    const output = await saga.handlers[0].handlers.created(
      createSagaDispatchContext(
        { invoiceId: 'inv-1', attempts: 0 },
        {
          sagaId: 'saga-1',
          correlationId: 'corr-1',
          causationId: 'cause-1'
        }
      )
    );

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
