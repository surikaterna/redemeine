import { afterEach, expect, jest, test } from '@jest/globals';
import { waitForSettlement } from '../integration/settlementWait';

afterEach(() => jest.useRealTimers());

test('prompt child settlement clears the deadline before process exit', async () => {
  jest.useFakeTimers();
  await waitForSettlement(Promise.resolve(), 30_000);
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(30_000);
  expect(jest.getTimerCount()).toBe(0);
});

test('settlement rejection clears its timer and timeout rejects once', async () => {
  jest.useFakeTimers();
  await expect(waitForSettlement(Promise.reject(new Error('child exited')), 30_000)).rejects.toThrow('child exited');
  expect(jest.getTimerCount()).toBe(0);
  const pending = waitForSettlement(new Promise<void>(() => undefined), 30_000);
  jest.advanceTimersByTime(30_000);
  await expect(pending).rejects.toThrow('Child settlement timeout.');
  expect(jest.getTimerCount()).toBe(0);
});
