import { createHash } from 'node:crypto';
import type { ProjectionDefinition, ProjectionEvent, ProjectionDeduplicationStrategy } from '@redemeine/projection-runtime-core';
import { normalizeLiveRegistration } from '@redemeine/projection-transport';

export interface CounterState { count: number }

export const fixtureConfiguration = Object.freeze({
  version: 1,
  initialization: 'suffix_contributions',
  routing: 'event_stable_commutative',
  definitions: Object.freeze([
    Object.freeze({ name: 'model:inline-counter', strategy: 'in_document', defaulted: true }),
    Object.freeze({ name: 'model:own-counter', strategy: 'own_record', defaulted: false })
  ])
});

function add(state: CounterState, event: ProjectionEvent): void {
  const amount = event.payload.amount;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) throw new Error('model:invalid_amount');
  const count = state.count + amount;
  if (!Number.isSafeInteger(count)) throw new Error('model:counter_capacity');
  state.count = count;
}

function definition(name: string, ownRecord: boolean): ProjectionDefinition<CounterState> {
  const deduplication: ProjectionDeduplicationStrategy = { strategy: 'own_record' };
  const subscriptions: ProjectionDefinition<CounterState>['subscriptions'] = [];
  Object.freeze(subscriptions);
  return Object.freeze({ name, initialState: () => ({ count: 0 }),
    identity: (event: ProjectionEvent) => event.payload.target === 'shared' ? 'shared' : [],
    subscriptions,
    ...(ownRecord ? { deduplication } : {}),
    fromStream: Object.freeze({
      aggregate: Object.freeze({ aggregateType: 'ModelCounter', initialState: Object.freeze({}),
        pure: Object.freeze({ eventProjectors: Object.freeze({}) }) }),
      handlers: Object.freeze({ Added: add })
    }) });
}

export function fixtureRegistry(generation = 'model:ephemeral-generation') {
  if (!generation || generation.length > 256) throw new Error('invalid_fixture_generation');
  return Object.freeze(fixtureConfiguration.definitions.map((entry) => Object.freeze({
    generation,
    definition: normalizeLiveRegistration({ definition: definition(entry.name, !entry.defaulted),
      initialization: 'suffix_contributions', routing: 'event_stable_commutative' })
  })));
}

export function fixtureRegistryDigest(artifactDigest: string): string {
  if (!/^[a-f0-9]{64}$/.test(artifactDigest)) throw new Error('artifact_identity_invalid');
  return createHash('sha256').update(JSON.stringify(fixtureConfiguration)).update('\n').update(artifactDigest).digest('hex');
}
