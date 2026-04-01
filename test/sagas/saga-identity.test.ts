import { describe, expect, it } from '@jest/globals';
import {
  parseSagaIdentityUrn,
  SagaIdentityValidationError,
  toSagaIdentityUrn,
  validateSagaIdentity,
  validateSagaName,
  validateSagaNamespace,
  validateSagaVersion
} from '../../src/sagas';

describe('saga identity validation and error mapping', () => {
  it('accepts valid namespace/name/version and derives canonical URN', () => {
    const identity = validateSagaIdentity({
      namespace: 'commerce.billing',
      name: 'invoice-reminder',
      version: 2
    });

    expect(identity).toEqual({
      namespace: 'commerce.billing',
      name: 'invoice-reminder',
      version: 2
    });

    expect(toSagaIdentityUrn(identity)).toBe('urn:redemeine:saga:commerce.billing:invoice-reminder:v2');
  });

  it('maps malformed namespace to deterministic typed error', () => {
    try {
      validateSagaNamespace('Commerce/Billing');
      throw new Error('expected validateSagaNamespace to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SagaIdentityValidationError);
      expect((error as SagaIdentityValidationError).code).toBe('SAGA_IDENTITY_INVALID_NAMESPACE');
      expect((error as SagaIdentityValidationError).field).toBe('namespace');
    }
  });

  it('maps malformed name to deterministic typed error', () => {
    try {
      validateSagaName('Invoice_Reminder');
      throw new Error('expected validateSagaName to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SagaIdentityValidationError);
      expect((error as SagaIdentityValidationError).code).toBe('SAGA_IDENTITY_INVALID_NAME');
      expect((error as SagaIdentityValidationError).field).toBe('name');
    }
  });

  it('maps invalid version classes to deterministic typed error', () => {
    for (const invalidVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      try {
        validateSagaVersion(invalidVersion);
        throw new Error('expected validateSagaVersion to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(SagaIdentityValidationError);
        expect((error as SagaIdentityValidationError).code).toBe('SAGA_IDENTITY_INVALID_VERSION');
        expect((error as SagaIdentityValidationError).field).toBe('version');
      }
    }
  });

  it('maps malformed URN class to deterministic typed error', () => {
    const malformedUrns = [
      'urn:redemeine:saga:commerce.billing:invoice-reminder',
      'urn:redemeine:saga:commerce.billing:invoice-reminder:version2',
      'urn:other:saga:commerce.billing:invoice-reminder:v2'
    ];

    for (const urn of malformedUrns) {
      try {
        parseSagaIdentityUrn(urn);
        throw new Error('expected parseSagaIdentityUrn to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(SagaIdentityValidationError);
        expect((error as SagaIdentityValidationError).code).toBe('SAGA_IDENTITY_MALFORMED_URN');
        expect((error as SagaIdentityValidationError).field).toBe('urn');
      }
    }
  });

  it('parses valid URN and reuses identity field validators', () => {
    expect(parseSagaIdentityUrn('urn:redemeine:saga:commerce.billing:invoice-reminder:v7')).toEqual({
      namespace: 'commerce.billing',
      name: 'invoice-reminder',
      version: 7
    });

    expect(() => parseSagaIdentityUrn('urn:redemeine:saga:Commerce:invoice-reminder:v7')).toThrow(
      SagaIdentityValidationError
    );
  });
});
