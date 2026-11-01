import { Shutdown } from '../src/shutdown';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test.each([130, 131])('finish refuses elapsed monotonic deadline at %s before the timer runs', async (elapsed) => {
  let now = 100;
  const forceExit = jest.fn();
  const onDeadline = jest.fn();
  const shutdown = new Shutdown(30, forceExit, onDeadline, () => now);
  expect(shutdown.begin()).toBe(true);
  now = 129;
  expect(shutdown.observeDeadline()).toBe(false);
  expect(shutdown.begin()).toBe(false);
  expect(shutdown.deadline).toBe(130);
  expect(forceExit).not.toHaveBeenCalled();
  now = elapsed;
  expect(shutdown.finish(0)).toBe(false);
  expect(await shutdown.done).toBe(124);
  expect(shutdown.expired).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
  expect(shutdown.observeDeadline()).toBe(true);
  expect(shutdown.finish(0)).toBe(false);
  jest.runOnlyPendingTimers();
  expect(forceExit).toHaveBeenCalledTimes(1);
  expect(forceExit).toHaveBeenCalledWith(124);
  expect(onDeadline).toHaveBeenCalledTimes(1);
});

test('timer expiration and later monotonic checks share the once-only expiration latch', async () => {
  let now = 100;
  const forceExit = jest.fn();
  const onDeadline = jest.fn();
  const shutdown = new Shutdown(30, forceExit, onDeadline, () => now);
  shutdown.begin();
  now = 130;
  jest.advanceTimersByTime(30);
  expect(await shutdown.done).toBe(124);
  expect(shutdown.observeDeadline()).toBe(true);
  expect(shutdown.finish(0)).toBe(false);
  expect(forceExit).toHaveBeenCalledTimes(1);
  expect(onDeadline).toHaveBeenCalledTimes(1);
});

test('completion before deadline clears its timer and cannot expire after completion', async () => {
  let now = 100;
  const forceExit = jest.fn();
  const shutdown = new Shutdown(30, forceExit, () => {}, () => now);
  shutdown.begin();
  now = 129;
  expect(shutdown.finish(0)).toBe(true);
  expect(await shutdown.done).toBe(0);
  now = 131;
  expect(shutdown.observeDeadline()).toBe(false);
  expect(shutdown.finish(0)).toBe(false);
  expect(jest.getTimerCount()).toBe(0);
  expect(forceExit).not.toHaveBeenCalled();
});

test('a throwing deadline observer cannot suppress or duplicate forced expiration', async () => {
  let now = 100;
  const forceExit = jest.fn();
  const shutdown = new Shutdown(30, forceExit, () => { throw new Error('observer_failure'); }, () => now);
  shutdown.begin();
  now = 130;
  expect(() => shutdown.observeDeadline()).toThrow('observer_failure');
  expect(await shutdown.done).toBe(124);
  expect(shutdown.finish(0)).toBe(false);
  expect(forceExit).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});
