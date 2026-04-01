import { describe, expect, it } from '@jest/globals';
import { createSaga } from '../../src/sagas';

describe('createSaga start/correlateBy/triggeredBy definition DSL', () => {
  it('requires correlateBy before triggeredBy/build and stores normalized contracts', () => {
    const predicate = (trigger: { source: 'event' | 'direct'; payload: { orderId: string } }) => trigger.source === 'event';

    const definition = createSaga<{ started: boolean }>('order-start-saga')
      .initialState(() => ({ started: false }))
      .start<{ orderId: string; source: 'event' | 'direct' }>((_start, _ctx) => undefined)
      .correlateBy((start) => start.orderId)
      .triggeredBy({
        kind: 'event',
        toStartInput: (trigger: { source: 'event' | 'direct'; payload: { orderId: string } }) => ({
          orderId: trigger.payload.orderId,
          source: trigger.source
        }),
        when: predicate
      })
      .triggeredBy({
        kind: 'direct',
        toStartInput: (trigger: { orderId: string }) => ({
          orderId: trigger.orderId,
          source: 'direct' as const
        })
      })
      .build();

    expect(definition.startContracts.start?.kind).toBe('definition-only');
    expect(typeof definition.startContracts.correlation?.correlateBy).toBe('function');
    expect(definition.startContracts.triggers).toHaveLength(2);
    expect(definition.startContracts.triggers[0].kind).toBe('event');
    expect(definition.startContracts.triggers[0].hasWhen).toBe(true);
    expect(definition.startContracts.triggers[0].when).toBe(predicate);
    expect(definition.startContracts.triggers[1].kind).toBe('direct');
    expect(definition.startContracts.triggers[1].hasWhen).toBe(false);
    expect(definition.startContracts.triggers[1].when).toBeUndefined();
  });

  it('enforces builder-phase gating at compile time', () => {
    const awaitingCorrelation = createSaga('gated-saga').start<{ orderId: string }>((_start, _ctx) => undefined);

    // @ts-expect-error build is unavailable before correlateBy
    type BuildBeforeCorrelateBy = typeof awaitingCorrelation.build;

    // @ts-expect-error triggeredBy is unavailable before correlateBy
    type TriggeredByBeforeCorrelateBy = typeof awaitingCorrelation.triggeredBy;

    const _typeSmoke: [BuildBeforeCorrelateBy?, TriggeredByBeforeCorrelateBy?] = [];
    expect(_typeSmoke).toHaveLength(0);

    expect(true).toBe(true);
  });

  it('requires trigger-to-start mappings and StartInput compatibility at compile time', () => {
    const correlated = createSaga('mapped-trigger-saga')
      .start<{ orderId: string; source: 'event' | 'direct' }>((_start, _ctx) => undefined)
      .correlateBy((start) => start.orderId);

    correlated.triggeredBy({
      kind: 'event',
      toStartInput: (trigger: { orderId: string }) => ({
        orderId: trigger.orderId,
        source: 'event' as const
      })
    });

    correlated.triggeredBy({
      kind: 'event',
      // @ts-expect-error mapped StartInput is missing required `source`
      toStartInput: (trigger: { orderId: string }) => ({ orderId: trigger.orderId })
    });

    // @ts-expect-error toStartInput mapping is required
    correlated.triggeredBy({
      kind: 'direct'
    });

    expect(true).toBe(true);
  });
});
