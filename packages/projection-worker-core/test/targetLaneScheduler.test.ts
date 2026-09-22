import { describe, expect, test } from '@jest/globals';
import { createProjectionLaneScheduler } from '../src';

describe('projection lane scheduler lifecycle', () => {
  test('reclaims high-cardinality idle lanes', async () => {
    const scheduler = createProjectionLaneScheduler();
    await Promise.all(Array.from({ length: 1_000 }, (_, index) =>
      scheduler.run([`lane-${index}`], async () => index)));
    expect(scheduler.size).toBe(0);
  });

  test('retains exact entries for queued overlap and a waiter added during completion', async () => {
    const scheduler = createProjectionLaneScheduler();
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    let late: Promise<void> | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const first = scheduler.run(['B', 'A'], async () => {
      events.push('start:first');
      started();
      await gate;
      late = scheduler.run(['B'], async () => { events.push('run:late'); });
      events.push('end:first');
    });
    const queued = scheduler.run(['B'], async () => { events.push('run:queued'); });
    await didStart;
    expect(scheduler.size).toBe(2);
    release();
    await Promise.all([first, queued]);
    await late;
    expect(events).toEqual(['start:first', 'end:first', 'run:queued', 'run:late']);
    expect(scheduler.size).toBe(0);
  });

  test('releases every lane after rejection', async () => {
    const scheduler = createProjectionLaneScheduler();
    await expect(scheduler.run(['A', 'B'], async () => {
      throw new Error('failed turn');
    })).rejects.toThrow('failed turn');
    expect(scheduler.size).toBe(0);
    await expect(scheduler.run(['A'], async () => 'recovered')).resolves.toBe('recovered');
  });

  test('allows independent lanes to run while overlap remains excluded', async () => {
    const scheduler = createProjectionLaneScheduler();
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const first = scheduler.run(['A'], async () => {
      events.push('start:A');
      started();
      await gate;
      events.push('end:A');
    });
    const overlap = scheduler.run(['A'], async () => { events.push('run:A2'); });
    const independent = scheduler.run(['C'], async () => { events.push('run:C'); });
    await didStart;
    await independent;
    expect(events).toEqual(['start:A', 'run:C']);
    release();
    await Promise.all([first, overlap]);
    expect(events).toEqual(['start:A', 'run:C', 'end:A', 'run:A2']);
    expect(scheduler.size).toBe(0);
  });
});
