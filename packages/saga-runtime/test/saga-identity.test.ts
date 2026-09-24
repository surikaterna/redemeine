import { describe, expect, it } from '@jest/globals';
import {
  assertMatchingSagaCorrelations,
  CorrelationMismatchError,
  deriveSagaInstanceId,
  deriveSagaRouteId,
  deriveSourceTriggerId,
  deriveTurnCommitId,
  encodeCanonicalIdentityPreimage,
  normalizeSagaCorrelation
} from '../src/index';

describe('saga runtime correlation identity', () => {
  it('normalizes strings to NFC while preserving case and type-tags numbers', () => {
    expect(normalizeSagaCorrelation('Cafe\u0301-ID')).toEqual({ type: 'string', value: 'Café-ID' });
    expect(normalizeSagaCorrelation(42)).toEqual({ type: 'number', value: 42 });
    expect(deriveSagaInstanceId('commerce/checkout', normalizeSagaCorrelation('42'))).not.toBe(
      deriveSagaInstanceId('commerce/checkout', normalizeSagaCorrelation(42))
    );
  });

  it.each([null, undefined, true, {}, [], 1n, -0, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, ''])('rejects unsupported correlation %#', (value) =>
    expect(() => normalizeSagaCorrelation(value)).toThrow()
  );

  it('enforces the normalized UTF-8 string bound', () => {
    expect(() => normalizeSagaCorrelation('é', 2)).not.toThrow();
    expect(() => normalizeSagaCorrelation('é', 1)).toThrow();
  });

  it('matches canonical correlations and rejects normalized mismatches', () => {
    const start = normalizeSagaCorrelation('order-42');
    expect(assertMatchingSagaCorrelations(start, normalizeSagaCorrelation('order-42'))).toBe(start);
    expect(() => assertMatchingSagaCorrelations(start, normalizeSagaCorrelation(42))).toThrow(CorrelationMismatchError);
  });
});

describe('deterministic saga IDs', () => {
  it('uses exact length-prefixed identity preimages', () => {
    expect(Array.from(encodeCanonicalIdentityPreimage('d', ['a:b', 'c']))).toEqual([0, 0, 0, 1, 100, 0, 0, 0, 3, 97, 58, 98, 0, 0, 0, 1, 99]);
    expect(encodeCanonicalIdentityPreimage('d', ['a', 'b'])).not.toEqual(encodeCanonicalIdentityPreimage('d', ['a:b']));
  });

  it('matches fixed domain-separated SHA-256/base64url vectors', () => {
    const instanceId = deriveSagaInstanceId('commerce/checkout', normalizeSagaCorrelation('order-42'));
    const sourceTriggerId = deriveSourceTriggerId({
      partitionId: 'partition-1',
      streamId: 'orders-42',
      commitId: 'commit-7',
      eventIndex: 0
    });
    const routeId = deriveSagaRouteId({
      kind: 'on',
      sagaKey: 'commerce/checkout',
      definitionVersion: 1,
      aggregateType: 'orders',
      handlerKey: 'placed',
      eventType: 'orders.placed.event'
    });
    const turnCommitId = deriveTurnCommitId({
      sourceTriggerId,
      sagaKey: 'commerce/checkout',
      instanceId,
      routeId
    });

    expect(instanceId).toBe('saga_i_C4l4-gZ3_wSLMWdHDs4FkbnLowMyHW0RcEYwFAM24KI');
    expect(sourceTriggerId).toBe('saga_t_Y0u4POR427KeDiqZTOWSt1O3SeCz7kZCqY9yU-JkqGk');
    expect(routeId).toBe('saga_r_XREZUvcFF_aHyQ4RE0GipHIj0nYW3hAOhRsKLZq-avc');
    expect(turnCommitId).toBe('saga_c_dMayWBoIuqAGRpULXdG_7VvPsTQkAFr2yViJymy6dME');
  });

  it('includes definition version in route and turn identity without changing instance identity', () => {
    const instanceId = deriveSagaInstanceId('commerce/checkout', normalizeSagaCorrelation('order-42'));
    const sourceTriggerId = deriveSourceTriggerId({ partitionId: 'p', streamId: 's', commitId: 'c', eventIndex: 0 });
    const route = (definitionVersion: number) =>
      deriveSagaRouteId({
        kind: 'on',
        sagaKey: 'commerce/checkout',
        definitionVersion,
        aggregateType: 'orders',
        handlerKey: 'placed',
        eventType: 'orders.placed.event'
      });
    const routeV1 = route(1);
    const routeV2 = route(2);
    expect(routeV2).toBe('saga_r_DycQtO5YcUDaT0wBQIhV6flECE2D1lmDhvYlAAhpfss');
    expect(routeV1).not.toBe(routeV2);
    expect(deriveTurnCommitId({ sourceTriggerId, sagaKey: 'commerce/checkout', instanceId, routeId: routeV1 })).not.toBe(
      deriveTurnCommitId({ sourceTriggerId, sagaKey: 'commerce/checkout', instanceId, routeId: routeV2 })
    );
    expect(deriveSagaInstanceId('commerce/checkout', normalizeSagaCorrelation('order-42'))).toBe(instanceId);
  });

  it('keeps instance identity independent of definition version and turn IDs fanout-safe', () => {
    const correlation = normalizeSagaCorrelation('order-42');
    const instanceV1 = deriveSagaInstanceId('commerce/checkout', correlation);
    const instanceV2 = deriveSagaInstanceId('commerce/checkout', correlation);
    expect(instanceV2).toBe(instanceV1);

    const common = { sourceTriggerId: 'trigger-1', sagaKey: 'commerce/checkout', instanceId: instanceV1 };
    expect(deriveTurnCommitId({ ...common, routeId: 'route-a' })).not.toBe(deriveTurnCommitId({ ...common, routeId: 'route-b' }));
  });

  it('uses source position rather than eventId and validates zero-based event indexes', () => {
    const source = { partitionId: 'p', streamId: 's', commitId: 'c', eventIndex: 0 };
    expect(deriveSourceTriggerId(source)).toBe(deriveSourceTriggerId({ ...source }));
    expect(() => deriveSourceTriggerId({ ...source, eventIndex: -1 })).toThrow(RangeError);
  });
});
