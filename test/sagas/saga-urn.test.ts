import { describe, expect, it } from '@jest/globals';
import { deriveSagaInstanceUrn, deriveSagaUrn, type SagaStructuredIdentity } from '../../src/sagas';

describe('saga URN derivation', () => {
  const identity: SagaStructuredIdentity = {
    namespace: 'commerce',
    name: 'checkout',
    version: 3
  };

  it('derives canonical saga URN deterministically', () => {
    expect(deriveSagaUrn(identity)).toBe('urn:redemeine:saga:commerce:checkout:v3');
    expect(deriveSagaUrn(identity)).toBe('urn:redemeine:saga:commerce:checkout:v3');
  });

  it('derives canonical saga instance URN with explicit instance id', () => {
    expect(deriveSagaInstanceUrn(identity, 'instance-42')).toBe(
      'urn:redemeine:saga-instance:commerce:checkout:v3:instance-42'
    );
  });

  it('throws for invalid identity fields', () => {
    expect(() => deriveSagaUrn({ ...identity, namespace: '' })).toThrow(TypeError);
    expect(() => deriveSagaUrn({ ...identity, name: '' })).toThrow(TypeError);
    expect(() => deriveSagaUrn({ ...identity, version: 0 })).toThrow(TypeError);
    expect(() => deriveSagaUrn({ ...identity, version: 1.5 })).toThrow(TypeError);
  });

  it('throws for invalid instance id', () => {
    expect(() => deriveSagaInstanceUrn(identity, '')).toThrow(TypeError);
  });
});
