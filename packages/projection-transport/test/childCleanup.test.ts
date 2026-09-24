import { afterEach, expect, jest, test } from '@jest/globals';
import { cleanupChildResources } from '../integration/childCleanup';
import { waitForSettlement } from '../integration/settlementWait';

afterEach(() => jest.useRealTimers());

test('settlement timeout closes each injected resource without masking the original error', async () => {
  jest.useFakeTimers();
  const settlement = waitForSettlement(new Promise<void>(() => undefined), 30_000);
  const observed = settlement.catch((error: unknown) => error);
  jest.advanceTimersByTime(30_000);
  const original = await observed;
  expect(original).toBeInstanceOf(Error);
  expect((original as Error).message).toBe('Child settlement timeout.');
  const calls: string[] = [];
  const reports: string[] = [];
  const resources = {
    worker: { stop: async () => { calls.push('worker'); throw new Error('worker stop unavailable'); } },
    channel: { close: async () => { calls.push('channel'); } },
    rabbit: { close: async () => { calls.push('rabbit'); throw new Error('rabbit already closed'); } },
    mongo: { close: async () => { calls.push('mongo'); } }
  };
  await expect(cleanupChildResources(resources, original, 1_000, (message) => reports.push(message)))
    .rejects.toBe(original);
  expect(calls).toEqual(['worker', 'channel', 'rabbit', 'mongo']);
  expect(reports[0]).toContain('worker stop unavailable');
  expect(jest.getTimerCount()).toBe(0);
  await expect(cleanupChildResources(resources, original, 1_000, () => { throw new Error('stderr unavailable'); }))
    .rejects.toBe(original);
});

test('bounded stop failure does not prevent Rabbit/Mongo closure', async () => {
  jest.useFakeTimers();
  const calls: string[] = [];
  const cleanup = cleanupChildResources({
    worker: { stop: () => new Promise<void>(() => undefined) },
    channel: { close: async () => { calls.push('channel'); } },
    rabbit: { close: async () => { calls.push('rabbit'); } },
    mongo: { close: async () => { calls.push('mongo'); } }
  }, undefined, 100, () => undefined);
  const rejected = expect(cleanup).rejects.toThrow('worker.stop: cleanup deadline exceeded');
  await jest.advanceTimersByTimeAsync(100);
  await rejected;
  expect(calls).toEqual(['channel', 'rabbit', 'mongo']);
  expect(jest.getTimerCount()).toBe(0);
});
