import type { ProjectionCommitDefinition } from '@redemeine/projection-runtime-core';

interface RuntimeState {
  count: number;
  seen: number[];
}

function definition(
  name: string,
  prefix: string,
  deduplication: ProjectionCommitDefinition<RuntimeState>['deduplication'],
  aggregateType = 'Order'
): ProjectionCommitDefinition<RuntimeState> {
  return {
    name,
    fromStream: {
      aggregate: { aggregateType, initialState: {}, pure: { eventProjectors: {} } },
      handlers: {
        Changed(state, event, context) {
          state.count += Number(event.payload.amount);
          state.seen.push(Number(event.payload.amount));
          context.subscribeTo({ aggregateType: `Linked${prefix}` }, event.aggregateId);
        }
      }
    },
    initialState: () => ({ count: 0, seen: [] }),
    identity: (event) => `${prefix}:${event.aggregateId}`,
    subscriptions: [],
    deduplication
  };
}

export function runtimeDefinitions(generation: string) {
  return [
    { generation, definition: definition('P-own', 'P', { strategy: 'own_record' }) },
    { generation, definition: definition('N-none', 'N', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'crash matrix' }) },
    { generation, definition: definition('Q-inline', 'Q', { strategy: 'in_document' }) },
    { generation, definition: definition('O-own-no-target', 'O', { strategy: 'own_record' }, 'Other') }
  ] as const;
}

export const identityConfigurations = [
  { mode: 'prefixedAggregateId', prefix: 'P' },
  { mode: 'prefixedAggregateId', prefix: 'N' },
  { mode: 'prefixedAggregateId', prefix: 'Q' },
  { mode: 'prefixedAggregateId', prefix: 'O' }
] as const;
