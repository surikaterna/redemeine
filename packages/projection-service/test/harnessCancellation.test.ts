import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { publishMalformed, type TransportConnection } from '../integration/transportFaults';
import { independentlyCleanup } from '../integration/cancellation';
import { budgets } from '../integration/plan';
import { OfflineConnection, OfflineChannel } from './support/offlineTransport';
import { deferred } from './support/deferred';

async function flush(): Promise<void> { for (let step = 0; step < 30; step += 1) await Promise.resolve(); }

describe('offline transport cancellation', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('never-confirm abort settles and closes both owned resources with unjoined evidence', async () => {
    const connection = new OfflineConnection(); const controller = new AbortController(); const labels: string[] = [];
    const result = publishMalformed('amqp://127.0.0.1:1/', 'source', controller.signal,
      { connect: async () => connection, unjoined: (label) => labels.push(label) }).catch((error: unknown) => error);
    await flush(); expect(connection.channel.published).toBe(1);
    controller.abort(); await flush();
    expect(await result).toBeInstanceOf(Error);
    expect(labels).toContain('transport_publish_confirm');
    expect(connection.channel.closeCalls).toBe(1); expect(connection.closeCalls).toBe(1);
  });

  test('late connection after abort is observed and closed without creating a channel', async () => {
    const acquired = deferred<TransportConnection>(); const connection = new OfflineConnection(); const controller = new AbortController();
    const result = publishMalformed('amqp://127.0.0.1:1/', 'source', controller.signal,
      { connect: async () => acquired.promise }).catch((error: unknown) => error);
    await flush(); controller.abort(); expect(await result).toBeInstanceOf(Error);
    acquired.resolve(connection); await flush();
    expect(connection.closeCalls).toBe(1); expect(connection.channelCalls).toBe(0);
  });

  test('late channel after abort is closed and cannot publish', async () => {
    const acquired = deferred<OfflineChannel>(); const channel = new OfflineChannel(); const connection = new OfflineConnection();
    connection.createConfirmChannel = async () => acquired.promise;
    const controller = new AbortController();
    const result = publishMalformed('amqp://127.0.0.1:1/', 'source', controller.signal,
      { connect: async () => connection }).catch((error: unknown) => error);
    await flush(); controller.abort(); await flush(); expect(await result).toBeInstanceOf(Error);
    acquired.resolve(channel); await flush(); expect(channel.closeCalls).toBe(1); expect(channel.published).toBe(0);
  });

  test('never-close phases are bounded independently and cannot be falsely joined', async () => {
    const connection = new OfflineConnection(); connection.neverClose = true; connection.channel.neverClose = true;
    const controller = new AbortController(); const labels: string[] = [];
    const result = publishMalformed('amqp://127.0.0.1:1/', 'source', controller.signal,
      { connect: async () => connection, unjoined: (label) => labels.push(label) }).catch((error: unknown) => error);
    await flush(); controller.abort(); await flush();
    await jest.advanceTimersByTimeAsync(budgets.commandMs * 2 + 1);
    expect(await result).toBeInstanceOf(Error);
    expect(labels).toContain('transport_channel_close'); expect(labels).toContain('transport_connection_close');
  });

  test('outer work cancellation reaches independent cleanup even if work never settles; late failure remains observed', async () => {
    const work = deferred<void>(); const controller = new AbortController(); const cleanup = jest.fn(async () => {}); const labels: string[] = [];
    const result = independentlyCleanup(() => work.promise, cleanup, controller.signal, performance.now() + 1000,
      (label) => labels.push(label)).catch((error: unknown) => error);
    await flush(); controller.abort(); expect(await result).toBeInstanceOf(Error);
    expect(cleanup).toHaveBeenCalledTimes(1); expect(labels).toContain('runner_work');
    work.reject(new Error('late-error')); await flush();
  });

  test('independent cleanup itself has an absolute deadline', async () => {
    const controller = new AbortController(); const labels: string[] = [];
    const result = independentlyCleanup(async () => {}, () => new Promise<void>(() => {}), controller.signal,
      performance.now() + 1000, (label) => labels.push(label), 50).catch((error: unknown) => error);
    await flush(); await jest.advanceTimersByTimeAsync(50);
    expect(await result).toBeInstanceOf(Error); expect(labels).toContain('runner_cleanup');
  });
});

test('actual offline child enters cleanup and final guard terminates residual handles without Docker or network', () => {
  const result = spawnSync(process.execPath, [join(__dirname, '.built/harnessAbortProcess.js')], { env: {}, encoding: 'utf8', timeout: 4000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.signal).toBeNull(); expect(result.stderr).toBe('');
  expect(result.stdout).toContain('"cleanupEntered":true,"published":1,"network":false,"docker":false');
  expect(result.stdout).toContain('"guardFired":true'); expect(result.stdout).toContain('runner_work');
});
