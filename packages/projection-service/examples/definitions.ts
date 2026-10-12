import type { LiveRegistration } from '@redemeine/projection-transport';

interface LedgerState { total: number }
export const registrations: LiveRegistration<LedgerState>[] = [{
  initialization: 'suffix_contributions', routing: 'event_stable_commutative',
  definition: {
    name: 'ledger:total', subscriptions: [], initialState: () => ({ total: 0 }),
    identity: (event) => event.payload.account === 'shared' ? 'shared' : [],
    fromStream: { aggregate: { aggregateType: 'Ledger', initialState: {}, pure: { eventProjectors: {} } },
      handlers: { Credited: (state, event) => {
        const amount = event.payload.amount;
        if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) throw new Error('invalid_ledger_credit');
        state.total += amount;
      } } }
  }
}];
