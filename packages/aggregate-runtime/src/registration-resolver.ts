/**
 * Aggregate registration lookup.
 * Builds a map at initialization for O(1) resolution by aggregate type.
 */

import type { AggregateRegistration } from './runtime';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Resolves an aggregate registration by its type name.
 */
export type RegistrationResolver = {
  resolve(aggregateType: string): AggregateRegistration | undefined;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a resolver backed by a pre-built Map of registrations.
 * Deterministic — same registrations always produce the same resolver.
 */
export function createRegistrationResolver(
  registrations: ReadonlyArray<AggregateRegistration>,
): RegistrationResolver {
  const byType = new Map<string, AggregateRegistration>();
  for (const reg of registrations) {
    byType.set(reg.aggregateType, reg);
  }

  return {
    resolve(aggregateType: string): AggregateRegistration | undefined {
      return byType.get(aggregateType);
    },
  };
}
