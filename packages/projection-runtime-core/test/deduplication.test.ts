import { describe, expect, test } from '@jest/globals';
import { createProjection } from '../src';

const aggregate = {
  aggregateType: 'invoice',
  pure: { eventProjectors: { created: () => undefined } }
};

describe('runtime projection deduplication builder', () => {
  test('retains explicit strategy on commit definitions', () => {
    const strategies = [
      { strategy: 'in_document' as const },
      { strategy: 'own_record' as const },
      {
        strategy: 'none' as const,
        duplicateEffects: 'acknowledged' as const,
        reason: 'handler effects are idempotent'
      }
    ];

    const definitions = strategies.map((strategy) => createProjection('summary', () => ({}))
      .from(aggregate, {})
      .deduplication(strategy)
      .buildCommitDefinition());

    expect(definitions.map((definition) => definition.deduplication.strategy))
      .toEqual(['in_document', 'own_record', 'none']);
  });
});
