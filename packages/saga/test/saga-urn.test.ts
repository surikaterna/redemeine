import { describe, expect, it } from '@jest/globals';
import {
  deriveSagaInstanceUrn,
  deriveSagaUrn,
  parseSagaUrn,
  type SagaStructuredIdentity
} from '../src';

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

  it('parses canonical URN into structured identity', () => {
    const canonicalUrn = deriveSagaUrn(identity);

    expect(canonicalUrn).toBe('urn:redemeine:saga:commerce:checkout:v3');
    expect(parseSagaUrn(canonicalUrn)).toEqual({
      namespace: 'commerce',
      name: 'checkout',
      version: 3,
      sagaKey: 'commerce/checkout',
      sagaType: 'commerce/checkout@v3',
      sagaUrn: canonicalUrn
    });
  });

  it('derives canonical saga instance URN with explicit instance id', () => {
    expect(deriveSagaInstanceUrn(identity, 'instance-42')).toBe(
      'urn:redemeine:saga:commerce:checkout:v3:instance:instance-42'
    );
  });

  it('throws for invalid identity fields', () => {
    expect(() => deriveSagaUrn({ ...identity, namespace: '' })).toThrow();
    expect(() => deriveSagaUrn({ ...identity, name: '' })).toThrow();
    expect(() => deriveSagaUrn({ ...identity, version: 0 })).toThrow();
    expect(() => deriveSagaUrn({ ...identity, version: 1.5 })).toThrow();
  });

  it('throws for invalid instance id', () => {
    expect(() => deriveSagaInstanceUrn(identity, '')).toThrow(TypeError);
  });
});
