import { describe, expect, it } from '@jest/globals';
import { createSagaTriggerBuilder } from '../../src/sagas';

describe('saga trigger builder DSL (definition-only)', () => {
  it('supports event, parent, direct and recovery triggers with required toStartInput', () => {
    const triggers = createSagaTriggerBuilder<{ sagaId: string; source: string }>();

    const eventTrigger = triggers
      .event<{ orderId: string; amount: number }>({
        event: 'orders.created',
        toStartInput: (source) => ({ sagaId: source.orderId, source: 'event' })
      })
      .when((source) => source.amount > 0)
      .build();

    const parentTrigger = triggers
      .parent<{ parentSagaId: string }>({
        allowList: ['parent-a'],
        requiredCapability: 'link:start',
        toStartInput: (source) => ({ sagaId: source.parentSagaId, source: 'parent' })
      })
      .build();

    const directTrigger = triggers
      .direct<{ commandId: string }>({
        channel: 'api',
        toStartInput: (source) => ({ sagaId: source.commandId, source: 'direct' })
      })
      .build();

    const recoveryTrigger = triggers
      .recovery<{ failedSagaId: string }>({
        reason: 'retry-window-open',
        toStartInput: (source) => ({ sagaId: source.failedSagaId, source: 'recovery' })
      })
      .build();

    expect(eventTrigger.family).toBe('event');
    expect(parentTrigger.family).toBe('parent');
    expect(directTrigger.family).toBe('direct');
    expect(recoveryTrigger.family).toBe('recovery');
    expect(eventTrigger.when).toHaveLength(1);
  });

  it('provides schedule entry points with semantics and DST defaults', () => {
    const triggers = createSagaTriggerBuilder<{ sagaId: string; kind: string }>();

    const interval = triggers.schedule.interval({
      everyMs: 30_000,
      toStartInput: (source) => ({ sagaId: source.occurrenceId, kind: source.kind })
    }).build();

    const isoInterval = triggers.schedule.isoInterval({
      isoInterval: 'PT30S',
      toStartInput: (source) => ({ sagaId: source.occurrenceId, kind: source.kind })
    }).build();

    const cron = triggers.schedule.cron({
      cron: '0 9 * * MON-FRI',
      timezone: 'Europe/Stockholm',
      toStartInput: (source) => ({ sagaId: source.occurrenceId, kind: source.kind })
    }).build();

    const rrule = triggers.schedule.rrule({
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      timezone: 'Europe/Stockholm',
      toStartInput: (source) => ({ sagaId: source.occurrenceId, kind: source.kind })
    }).build();

    expect(interval.schedule.kind).toBe('interval');
    expect(interval.schedule.metadata.semantics).toBe('elapsed-time');
    expect(interval.schedule.metadata.dstPolicy.ambiguousTime).toBe('first-occurrence-only');
    expect(interval.schedule.metadata.dstPolicy.nonexistentTime).toBe('next-valid-time');

    expect(isoInterval.schedule.kind).toBe('isoInterval');
    expect(isoInterval.schedule.metadata.semantics).toBe('elapsed-time');

    expect(cron.schedule.kind).toBe('cron');
    expect(cron.schedule.timezone).toBe('Europe/Stockholm');
    expect(cron.schedule.metadata.semantics).toBe('wall-clock');

    expect(rrule.schedule.kind).toBe('rrule');
    expect(rrule.schedule.timezone).toBe('Europe/Stockholm');
    expect(rrule.schedule.metadata.semantics).toBe('wall-clock');
  });

  it('keeps when chaining and source/start-input type inference strong', () => {
    const triggers = createSagaTriggerBuilder<{ key: string; retries: number }>();

    const def = triggers
      .event<{ id: string; retries: number }>({
        event: 'orders.retry.requested',
        toStartInput: (source) => ({ key: source.id, retries: source.retries })
      })
      .when((source, startInput) => {
        const id: string = source.id;
        const retries: number = startInput.retries;
        expect(id).toBeDefined();
        expect(retries).toBeGreaterThanOrEqual(0);
        return startInput.retries < 5;
      })
      .when((source, startInput) => source.retries === startInput.retries)
      .build();

    expect(def.when).toHaveLength(2);

    createSagaTriggerBuilder<{ id: string }>().event<{ id: string }>({
      event: 'orders.created',
      // @ts-expect-error toStartInput must return StartInput shape
      toStartInput: (_source) => ({ missing: 'id' })
    });

    createSagaTriggerBuilder<{ id: string }>().event<{ id: string }>({
      event: 'orders.created',
      toStartInput: (source) => ({ id: source.id })
    })
      .when((_source, startInput) => {
        // @ts-expect-error startInput.id is string, not number
        const invalid: number = startInput.id;
        expect(invalid).toBeDefined();
        return true;
      });
  });

  it('preserves chained when order and mapped payload for metadata checks', () => {
    const triggers = createSagaTriggerBuilder<{ sagaId: string; shouldStart: boolean }>();

    const firstWhen = (source: { orderId: string; amount: number }, startInput: { sagaId: string; shouldStart: boolean }) => (
      source.orderId === startInput.sagaId
    );
    const secondWhen = (_source: { orderId: string; amount: number }, startInput: { sagaId: string; shouldStart: boolean }) => (
      startInput.shouldStart
    );

    const trigger = triggers
      .event<{ orderId: string; amount: number }>({
        event: 'orders.created',
        toStartInput: (source) => ({ sagaId: source.orderId, shouldStart: source.amount > 0 })
      })
      .when(firstWhen)
      .when(secondWhen)
      .build();

    const mapped = trigger.toStartInput({ orderId: 'order-123', amount: 42 });

    expect(mapped).toEqual({ sagaId: 'order-123', shouldStart: true });
    expect(trigger.when).toEqual([firstWhen, secondWhen]);
    expect(trigger.when[0]({ orderId: 'order-123', amount: 42 }, mapped)).toBe(true);
    expect(trigger.when[1]({ orderId: 'order-123', amount: 42 }, mapped)).toBe(true);
  });
});
