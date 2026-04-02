import { describe, expect, it } from '@jest/globals';
import {
  parseSagaUrn,
  deriveSagaUrn,
  normalizeSagaIdentity,
  SagaIdentityNormalizationError
} from '../src';

describe('saga identity validation and error mapping', () => {
  it('accepts valid namespace/name/version and derives canonical URN', () => {
    const identity = normalizeSagaIdentity({
      namespace: 'commerce.billing',
      name: 'invoice-reminder',
      version: 2
    });

    expect(identity).toEqual({
      namespace: 'commerce.billing',
      name: 'invoice-reminder',
      version: 2,
      sagaKey: 'commerce.billing/invoice-reminder',
      sagaType: 'commerce.billing/invoice-reminder@v2',
      sagaUrn: 'urn:redemeine:saga:commerce.billing:invoice-reminder:v2'
    });

    expect(deriveSagaUrn(identity)).toBe('urn:redemeine:saga:commerce.billing:invoice-reminder:v2');
  });

  it('accepts canonical separators used by normalization contract', () => {
    const identity = normalizeSagaIdentity({
      namespace: '1commerce.billing2',
      name: 'invoice.reminder_v2',
      version: 3
    });

    expect(deriveSagaUrn(identity)).toBe('urn:redemeine:saga:1commerce.billing2:invoice.reminder_v2:v3');
  });

  it('maps malformed namespace to deterministic typed error', () => {
    try {
      normalizeSagaIdentity({ namespace: 'Commerce/Billing', name: 'invoice-reminder', version: 2 });
      throw new Error('expected normalizeSagaIdentity to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SagaIdentityNormalizationError);
      expect((error as SagaIdentityNormalizationError).code).toBe('invalid_namespace');
    }
  });

  it('maps malformed name to deterministic typed error', () => {
    try {
      normalizeSagaIdentity({ namespace: 'commerce.billing', name: 'Invoice Reminder', version: 2 });
      throw new Error('expected normalizeSagaIdentity to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SagaIdentityNormalizationError);
      expect((error as SagaIdentityNormalizationError).code).toBe('invalid_name');
    }
  });

  it('maps invalid version classes to deterministic typed error', () => {
    for (const invalidVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      try {
        normalizeSagaIdentity({ namespace: 'commerce.billing', name: 'invoice-reminder', version: invalidVersion });
        throw new Error('expected normalizeSagaIdentity to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(SagaIdentityNormalizationError);
        expect((error as SagaIdentityNormalizationError).code).toBe('invalid_version');
      }
    }
  });

  it('maps malformed URN class to deterministic typed error', () => {
    const malformedUrns = [
      'urn:redemeine:saga:commerce.billing:invoice-reminder',
      'urn:redemeine:saga:commerce.billing:invoice-reminder:version2',
      'urn:redemeine:saga:commerce.billing:invoice-reminder:v01',
      'urn:redemeine:saga:commerce.billing:invoice-reminder:v2.0',
      'urn:other:saga:commerce.billing:invoice-reminder:v2'
    ];

    for (const urn of malformedUrns) {
      expect(() => parseSagaUrn(urn)).toThrow(TypeError);
    }
  });

  it('parses valid URN and reuses identity field validators', () => {
    expect(parseSagaUrn('urn:redemeine:saga:commerce.billing:invoice-reminder:v7')).toEqual({
      namespace: 'commerce.billing',
      name: 'invoice-reminder',
      version: 7,
      sagaKey: 'commerce.billing/invoice-reminder',
      sagaType: 'commerce.billing/invoice-reminder@v7',
      sagaUrn: 'urn:redemeine:saga:commerce.billing:invoice-reminder:v7'
    });

    expect(parseSagaUrn('urn:redemeine:saga:Commerce:invoice-reminder:v7')).toEqual({
      namespace: 'commerce',
      name: 'invoice-reminder',
      version: 7,
      sagaKey: 'commerce/invoice-reminder',
      sagaType: 'commerce/invoice-reminder@v7',
      sagaUrn: 'urn:redemeine:saga:commerce:invoice-reminder:v7'
    });
  });
});
