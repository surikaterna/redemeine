import { describe, expect, it } from '@jest/globals';
import { createSagaTriggerBuilder } from '../../src/sagas';

function getOffsetMinutesAt(utcIso: string, timezone: string): number {
  const date = new Date(utcIso);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const parts = formatter.formatToParts(date);
  const asNumber = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);

  const year = asNumber('year');
  const month = asNumber('month');
  const day = asNumber('day');
  const hour = asNumber('hour');
  const minute = asNumber('minute');
  const second = asNumber('second');

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return (asUtc - date.getTime()) / 60_000;
}

describe('schedule trigger DST semantics (definition-only metadata checks)', () => {
  const timezones = ['Europe/Stockholm', 'America/New_York'] as const;

  it.each(timezones)('marks ambiguous fall-back slots as first-occurrence-only for %s', (timezone) => {
    const trigger = createSagaTriggerBuilder<{ id: string }>().schedule.cron({
      cron: '30 1 * * *',
      timezone,
      toStartInput: (source) => ({ id: source.occurrenceId })
    }).build();

    expect(trigger.schedule.metadata.dstPolicy.ambiguousTime).toBe('first-occurrence-only');

    if (timezone === 'Europe/Stockholm') {
      expect(getOffsetMinutesAt('2025-10-26T00:30:00.000Z', timezone)).toBe(120);
      expect(getOffsetMinutesAt('2025-10-26T01:30:00.000Z', timezone)).toBe(60);
    }

    if (timezone === 'America/New_York') {
      expect(getOffsetMinutesAt('2025-11-02T05:30:00.000Z', timezone)).toBe(-240);
      expect(getOffsetMinutesAt('2025-11-02T06:30:00.000Z', timezone)).toBe(-300);
    }
  });

  it.each(timezones)('marks nonexistent spring-forward slots as next-valid-time for %s', (timezone) => {
    const trigger = createSagaTriggerBuilder<{ id: string }>().schedule.rrule({
      rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=30',
      timezone,
      toStartInput: (source) => ({ id: source.occurrenceId })
    }).build();

    expect(trigger.schedule.metadata.dstPolicy.nonexistentTime).toBe('next-valid-time');

    if (timezone === 'Europe/Stockholm') {
      expect(getOffsetMinutesAt('2025-03-30T00:30:00.000Z', timezone)).toBe(60);
      expect(getOffsetMinutesAt('2025-03-30T01:30:00.000Z', timezone)).toBe(120);
    }

    if (timezone === 'America/New_York') {
      expect(getOffsetMinutesAt('2025-03-09T06:30:00.000Z', timezone)).toBe(-300);
      expect(getOffsetMinutesAt('2025-03-09T07:30:00.000Z', timezone)).toBe(-240);
    }
  });

  it('keeps interval and isoInterval schedules as elapsed-time semantics across DST boundaries', () => {
    const builder = createSagaTriggerBuilder<{ id: string }>();

    const interval = builder.schedule.interval({
      everyMs: 3_600_000,
      toStartInput: (source) => ({ id: source.occurrenceId })
    }).build();

    const isoInterval = builder.schedule.isoInterval({
      isoInterval: 'PT1H',
      toStartInput: (source) => ({ id: source.occurrenceId })
    }).build();

    expect(interval.schedule.metadata.semantics).toBe('elapsed-time');
    expect(isoInterval.schedule.metadata.semantics).toBe('elapsed-time');
    expect(interval.schedule.metadata.dstPolicy.ambiguousTime).toBe('first-occurrence-only');
    expect(interval.schedule.metadata.dstPolicy.nonexistentTime).toBe('next-valid-time');

    const beforeSpringForward = Date.parse('2025-03-30T00:30:00.000Z');
    const afterSpringForward = Date.parse('2025-03-30T01:30:00.000Z');
    expect(afterSpringForward - beforeSpringForward).toBe(3_600_000);

    const beforeFallBack = Date.parse('2025-10-26T00:30:00.000Z');
    const afterFallBack = Date.parse('2025-10-26T01:30:00.000Z');
    expect(afterFallBack - beforeFallBack).toBe(3_600_000);
  });
});
