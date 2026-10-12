import { waitForConsumerActivation } from '../src/infrastructure/consumerActivation';
import { BrokerRefusal } from '../src/infrastructure/brokerSchema';
import { deferred } from './support/deferred';

afterEach(() => { jest.useRealTimers(); });

test('only typed pending is polled; readiness awaits a successful check', async () => {
  jest.useFakeTimers(); const current = jest.fn(); let settled = false;
  const check = jest.fn().mockRejectedValueOnce(new BrokerRefusal('broker_consumer_count_pending')).mockResolvedValue(undefined);
  const task = waitForConsumerActivation(check, current, new AbortController().signal).then(() => { settled = true; });
  await jest.advanceTimersByTimeAsync(0); expect(settled).toBe(false); expect(check).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(100); await task; expect(settled).toBe(true); expect(check).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
});

test.each(['broker_consumer_conflict', 'broker_consumer_count_inconsistent', 'broker_consumer_active_mismatch',
  'broker_queue_consumer_details_invalid', 'broker_management_unavailable'])('%s is never retried', async (code) => {
  jest.useFakeTimers(); const error = new BrokerRefusal(code); const check = jest.fn().mockRejectedValue(error);
  await expect(waitForConsumerActivation(check, () => {}, new AbortController().signal)).rejects.toBe(error);
  expect(check).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('pending has one absolute ten-second deadline, not a per-attempt timeout', async () => {
  jest.useFakeTimers(); const check = jest.fn().mockRejectedValue(new BrokerRefusal('broker_consumer_count_pending'));
  const result = waitForConsumerActivation(check, () => {}, new AbortController().signal).catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(10000);
  expect(await result).toMatchObject({ reason: 'broker_consumer_activation_deadline' });
  expect(check.mock.calls.length).toBeLessThanOrEqual(100); expect(jest.getTimerCount()).toBe(0);
});

test('deadline races a stuck inspection and observes late rejection without launching a second attempt', async () => {
  jest.useFakeTimers(); const pending = deferred<void>(); const check = jest.fn(() => pending.promise);
  const result = waitForConsumerActivation(check, () => {}, new AbortController().signal).catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(10000);
  expect(await result).toMatchObject({ reason: 'broker_consumer_activation_deadline' });
  pending.reject(new Error('late-inspection')); await jest.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('shutdown aborts pending immediately and cannot revive after later successful inspection', async () => {
  jest.useFakeTimers(); const pending = deferred<void>(); const controller = new AbortController(); let ready = false;
  const check = jest.fn(() => pending.promise);
  const result = waitForConsumerActivation(check, () => {}, controller.signal).then(() => { ready = true; }, (error: unknown) => error);
  controller.abort(); expect(await result).toMatchObject({ reason: 'broker_session_expired' });
  pending.resolve(); await jest.advanceTimersByTimeAsync(0);
  expect(ready).toBe(false); expect(check).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('late success beyond the monotonic deadline does not qualify even if timer has not fired', async () => {
  let now = 0;
  await expect(waitForConsumerActivation(async () => { now = 10000; }, () => {}, new AbortController().signal, () => now))
    .rejects.toThrow('broker_consumer_activation_deadline');
});
