import { describe, expect, test } from '@jest/globals';
import { createProjection } from '../src';

const aggregate = {
  aggregateType: 'invoice',
  pure: { eventProjectors: { created: () => undefined } }
};

describe('projection deduplication builder', () => {
  test.each(['in_document', 'own_record'] as const)('builds %s definitions', (strategy) => {
    const definition = createProjection('summary', () => ({}))
      .from(aggregate, {})
      .deduplication({
        strategy,
        warnings: { warnAtSourceCount: 1_000, warnAtMetadataBytes: 262_144 }
      })
      .buildCommitDefinition();

    expect(definition.deduplication.strategy).toBe(strategy);
  });

  test('requires an acknowledgement and nonempty reason for none', () => {
    const definition = createProjection('effects', () => ({}))
      .from(aggregate, {})
      .deduplication({
        strategy: 'none',
        duplicateEffects: 'acknowledged',
        reason: 'effects are idempotent downstream'
      })
      .buildCommitDefinition();

    expect(definition.deduplication.strategy).toBe('none');
    expect(() => createProjection('unsafe', () => ({}))
      .from(aggregate, {})
      .deduplication({ strategy: 'none', duplicateEffects: 'acknowledged', reason: ' ' }))
      .toThrow(/requires a reason/);
  });

  test('rejects incomplete none policies at compile time', () => {
    createProjection('invalid', () => ({})).from(aggregate, {});
    // @ts-expect-error none requires a typed duplicate-effects acknowledgement
    createProjection('invalid', () => ({})).deduplication({ strategy: 'none', reason: 'unsafe' });
  });
});
