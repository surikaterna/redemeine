import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, jest, test } from '@jest/globals';
import { awaitStackChild } from '../integration/childRunner';

class FakeChild extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly kill = jest.fn(() => true);
}

afterEach(() => jest.useRealTimers());

test('a promptly exited child retains stderr and elapsed time without a live timeout', async () => {
  jest.useFakeTimers();
  const child = new FakeChild();
  const pending = awaitStackChild(child as unknown as ChildProcess, 'normal', 45_000, Date.now, () => undefined);
  jest.advanceTimersByTime(25);
  child.stderr.write('scenario diagnostic');
  child.emit('close', 0, null);
  await expect(pending).resolves.toMatchObject({ scenario: 'normal', code: 0, elapsedMs: 25,
    stderr: 'scenario diagnostic' });
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(45_000);
  expect(child.kill).not.toHaveBeenCalled();
});

test('timeout kills only its child, returns scenario stderr and releases its timer', async () => {
  jest.useFakeTimers();
  const child = new FakeChild();
  const pending = awaitStackChild(child as unknown as ChildProcess, 'retry', 45_000, Date.now, () => undefined);
  child.stderr.write('source not ready');
  jest.advanceTimersByTime(45_000);
  await expect(pending).rejects.toThrow('retry: child timeout; elapsedMs=45000; stderr=source not ready');
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(jest.getTimerCount()).toBe(0);
});
