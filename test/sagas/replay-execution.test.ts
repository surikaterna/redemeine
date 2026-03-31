import { describe, expect, it, jest } from '@jest/globals';
import type { SagaReducerOutput } from '../../src/sagas';
import { executeSagaReducerOutputInReplay } from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('saga replay execution helper', () => {
  it('suppresses dispatch/schedule/runActivity side-effects in replay mode', async () => {
    const dispatch = jest.fn();
    const schedule = jest.fn();
    const runActivity = jest.fn();

    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 2 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-1', amount: 250 },
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        },
        {
          type: 'schedule',
          id: 'billing-reminder',
          delay: 5_000,
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-2'
          }
        },
        {
          type: 'run-activity',
          name: 'send-receipt',
          closure: () => {
            runActivity();
            return undefined;
          },
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-3'
          }
        }
      ]
    };

    const result = await executeSagaReducerOutputInReplay(output, {
      dispatch,
      schedule,
      runActivity
    });

    expect(result.state).toEqual({ attempts: 2 });
    expect(result.outcomes).toEqual([
      {
        intentType: 'dispatch',
        executed: false,
        reason: 'replay-mode-suppressed'
      },
      {
        intentType: 'schedule',
        executed: false,
        reason: 'replay-mode-suppressed'
      },
      {
        intentType: 'run-activity',
        executed: false,
        reason: 'replay-mode-suppressed'
      }
    ]);

    expect(dispatch).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(runActivity).not.toHaveBeenCalled();
  });
});
