import { describe, expect, it } from '@jest/globals';
import {
  SagaIdentityNormalizationError,
  buildSagaType,
  normalizeSagaIdentity
} from '../../src/sagas';

describe('saga identity normalization', () => {
  it('normalizes namespace/name/version and derives sagaType', () => {
    expect(normalizeSagaIdentity({
      namespace: ' Billing.Invoice ',
      name: 'Payment-Flow',
      version: '2'
    })).toEqual({
      namespace: 'billing.invoice',
      name: 'payment-flow',
      version: 2,
      sagaType: 'billing.invoice.payment-flow.v2'
    });
  });

  it('builds deterministic sagaType from canonical parts', () => {
    expect(buildSagaType('ops.reconciliation', 'rebuild_ledger', 7)).toBe('ops.reconciliation.rebuild_ledger.v7');
  });

  it('rejects invalid namespace values', () => {
    expect(() => normalizeSagaIdentity({
      namespace: 'Billing..Invoice',
      name: 'payment-flow',
      version: 1
    })).toThrow(SagaIdentityNormalizationError);

    try {
      normalizeSagaIdentity({
        namespace: 'Billing..Invoice',
        name: 'payment-flow',
        version: 1
      });
    } catch (error) {
      expect((error as SagaIdentityNormalizationError).code).toBe('invalid_namespace');
    }
  });

  it('rejects invalid name values', () => {
    expect(() => normalizeSagaIdentity({
      namespace: 'billing.invoice',
      name: 'payment flow',
      version: 1
    })).toThrow(SagaIdentityNormalizationError);

    try {
      normalizeSagaIdentity({
        namespace: 'billing.invoice',
        name: 'payment flow',
        version: 1
      });
    } catch (error) {
      expect((error as SagaIdentityNormalizationError).code).toBe('invalid_name');
    }
  });

  it('rejects invalid version values', () => {
    expect(() => normalizeSagaIdentity({
      namespace: 'billing.invoice',
      name: 'payment-flow',
      version: 'v1'
    })).toThrow(SagaIdentityNormalizationError);

    expect(() => normalizeSagaIdentity({
      namespace: 'billing.invoice',
      name: 'payment-flow',
      version: '2.0'
    })).toThrow(SagaIdentityNormalizationError);

    expect(() => normalizeSagaIdentity({
      namespace: 'billing.invoice',
      name: 'payment-flow',
      version: 'v2'
    })).toThrow(SagaIdentityNormalizationError);

    expect(() => normalizeSagaIdentity({
      namespace: 'billing.invoice',
      name: 'payment-flow',
      version: '01'
    })).toThrow(SagaIdentityNormalizationError);

    expect(() => normalizeSagaIdentity({
      namespace: 'billing.invoice',
      name: 'payment-flow',
      version: 0
    })).toThrow(SagaIdentityNormalizationError);

    try {
      normalizeSagaIdentity({
        namespace: 'billing.invoice',
        name: 'payment-flow',
        version: 'v1'
      });
    } catch (error) {
      expect((error as SagaIdentityNormalizationError).code).toBe('invalid_version');
    }
  });
});
