import { describe, expect, it } from '@jest/globals';
import { normalizeSagaIdentityInput } from '../../src/sagas';

describe('saga identity backward compatibility adapter', () => {
  it('accepts canonical structured identity objects without deprecation flags', () => {
    const result = normalizeSagaIdentityInput({
      sagaId: 'saga-1',
      correlationId: 'corr-1',
      causationId: 'cause-1'
    });

    expect(result.identity).toEqual({
      sagaId: 'saga-1',
      correlationId: 'corr-1',
      causationId: 'cause-1'
    });
    expect(result.deprecated).toBe(false);
    expect(result.deprecationNotes).toEqual([]);
  });

  it('maps legacy string identity inputs to canonical metadata shape', () => {
    const single = normalizeSagaIdentityInput('saga-legacy-1');
    expect(single.identity).toEqual({
      sagaId: 'saga-legacy-1',
      correlationId: 'saga-legacy-1',
      causationId: 'saga-legacy-1'
    });
    expect(single.deprecated).toBe(true);

    const triple = normalizeSagaIdentityInput('saga-2|corr-2|cause-2');
    expect(triple.identity).toEqual({
      sagaId: 'saga-2',
      correlationId: 'corr-2',
      causationId: 'cause-2'
    });
    expect(triple.deprecated).toBe(true);
  });

  it('maps legacy snake_case object identity inputs and marks deprecation', () => {
    const result = normalizeSagaIdentityInput({
      saga_id: 'saga-legacy-obj',
      correlation_id: 'corr-legacy-obj',
      causation_id: 'cause-legacy-obj'
    });

    expect(result.identity).toEqual({
      sagaId: 'saga-legacy-obj',
      correlationId: 'corr-legacy-obj',
      causationId: 'cause-legacy-obj'
    });
    expect(result.deprecated).toBe(true);
    expect(result.deprecationNotes.join(' ')).toContain('deprecated');
  });

  it('rejects unsupported legacy identity forms with clear guidance', () => {
    expect(() => normalizeSagaIdentityInput('saga|corr')).toThrow(
      'Unsupported legacy saga identity string format. Supported formats: "<sagaId>" or "<sagaId>|<correlationId>|<causationId>".'
    );

    expect(() => normalizeSagaIdentityInput({ saga: 'missing-supported-keys' } as never)).toThrow(
      'Unsupported saga identity object shape. Supported object fields: sagaId/correlationId/causationId or legacy saga_id/correlation_id/causation_id.'
    );
  });
});
