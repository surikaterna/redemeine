import { EventEmitter } from 'node:events';
import { ProjectionHost } from '../src/host';
import type { Ownership } from '../src/ownership';
import { referenceConfig } from './fixtures';
import { deferred } from './support/deferred';

test.each([false, true])('shutdown wins late ownership success, afterDeadline=%s', async (afterDeadline) => {
  const pending = deferred<Ownership>();
  const close = jest.fn(async () => {});
  const connect = jest.fn(async () => { throw new Error('must_not_connect'); });
  const signals = new EventEmitter();
  const forceExit = jest.fn();
  const host = new ProjectionHost({ ...referenceConfig, healthPort: 0, shutdownTimeoutMs: 100 }, {
    acquire: async () => pending.promise, connect, signals, forceExit
  });
  const done = host.start();
  signals.emit('SIGTERM');
  if (afterDeadline) expect(await done).toBe(124);
  pending.resolve({ close });
  if (!afterDeadline) expect(await done).toBe(0);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(connect).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(afterDeadline ? 0 : 1);
  expect(host.snapshot().referenceReady).toBe(false);
});
