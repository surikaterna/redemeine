import { describe, expect, it } from '@jest/globals';
import { testAggregate } from '../src/testAggregate';

class AlreadyOpenedError extends Error {
  constructor() {
    super('Account already opened');
    this.name = 'AlreadyOpenedError';
  }
}

type AccountState = {
  readonly id: string;
  readonly opened: boolean;
  readonly balance: number;
};

type EventEnvelope = {
  readonly type: string;
  readonly payload: unknown;
};

const accountAggregate = {
  initialState: {
    id: 'acc-1',
    opened: false,
    balance: 0
  } as AccountState,
  apply(state: AccountState, event: EventEnvelope): AccountState {
    switch (event.type) {
      case 'account.opened.event':
        return {
          ...state,
          opened: true
        };
      case 'account.deposited.event':
        return {
          ...state,
          balance: state.balance + (event.payload as { amount: number }).amount
        };
      default:
        return state;
    }
  },
  process(state: AccountState, command: { readonly type: string; readonly payload: unknown }): readonly EventEnvelope[] {
    switch (command.type) {
      case 'account.open.command': {
        if (state.opened) {
          throw new AlreadyOpenedError();
        }

        return [
          {
            type: 'account.opened.event',
            payload: { id: state.id }
          }
        ];
      }
      case 'account.deposit.command': {
        const payload = command.payload as { amount: number };
        if (payload.amount <= 0) {
          return [];
        }

        return [
          {
            type: 'account.deposited.event',
            payload: { amount: payload.amount }
          }
        ];
      }
      default:
        throw new Error(`Unknown command ${command.type}`);
    }
  },
  commandCreators: {
    open: () => ({
      type: 'account.open.command',
      payload: undefined
    }),
    deposit: (payload: { amount: number }) => ({
      type: 'account.deposit.command',
      payload
    })
  }
} as const;

describe('testAggregate fixture', () => {
  it('hydrates from given events and emits command events deterministically', () => {
    testAggregate(accountAggregate)
      .given([
        {
          type: 'account.opened.event',
          payload: { id: 'acc-1' }
        }
      ])
      .when('deposit', { amount: 25 })
      .expectEvents([
        {
          type: 'account.deposited.event',
          payload: { amount: 25 }
        }
      ])
      .expectState({
        id: 'acc-1',
        opened: true,
        balance: 25
      });
  });

  it('supports typed command envelope input in when(command)', () => {
    const command = accountAggregate.commandCreators.deposit({ amount: 10 });

    testAggregate(accountAggregate)
      .given([{ type: 'account.opened.event', payload: { id: 'acc-1' } }])
      .when(command)
      .expectEvents([{ type: 'account.deposited.event', payload: { amount: 10 } }])
      .expectState((state) => {
        expect(state.balance).toBe(10);
        expect(state.opened).toBe(true);
      });
  });

  it('asserts invariant rejection with expectError and no emitted events', () => {
    testAggregate(accountAggregate)
      .given([{ type: 'account.opened.event', payload: { id: 'acc-1' } }])
      .when('open')
      .expectError(AlreadyOpenedError, 'Account already opened')
      .expectNoEvents()
      .expectState({
        id: 'acc-1',
        opened: true,
        balance: 0
      });
  });

  it('asserts explicit no-event outcomes', () => {
    testAggregate(accountAggregate)
      .given([{ type: 'account.opened.event', payload: { id: 'acc-1' } }])
      .when('deposit', { amount: 0 })
      .expectNoEvents()
      .expectState({
        id: 'acc-1',
        opened: true,
        balance: 0
      });
  });
});
