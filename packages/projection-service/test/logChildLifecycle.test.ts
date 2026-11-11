import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { executeCapturedLogs, type LogProcessChild } from '../integration/logProcess';
import { Commands } from '../integration/commands';
import { Receipts } from '../integration/receipts';

class Child extends EventEmitter implements LogProcessChild {
  pid: number | undefined = 12345;
  stdout = new PassThrough(); stderr = new PassThrough(); closed = false;
  kill = jest.fn((_signal: NodeJS.Signals): boolean => true);
  fail(code: string): void { const error = new Error('private native message'); Object.assign(error, { code }); this.emit('error', error); }
  close(): void { this.closed = true; this.stdout.end(); this.stderr.end(); this.emit('close', 1, null); }
}
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test('post-spawn EPERM plus repeated errors keeps supervision and settles only after delayed close', async () => {
  jest.useFakeTimers(); const child = new Child(); let settled = false;
  const result = executeCapturedLogs('owned', [], process.cwd(), 100, new AbortController().signal, { spawn: () => child })
    .catch((error: unknown) => { settled = true; return error; });
  child.emit('spawn'); child.fail('EPERM'); child.fail('EACCES');
  await jest.advanceTimersByTimeAsync(150); expect(settled).toBe(false); expect(child.closed).toBe(false);
  expect(child.kill.mock.calls).toEqual([['SIGTERM']]); child.fail('EPERM'); child.close();
  expect(await result).toMatchObject({ reason: 'qualification_log_signal_failed' }); expect(child.closed).toBe(true);
  expect(jest.getTimerCount()).toBe(0); expect(() => child.fail('EPERM')).not.toThrow();
});

test('R10.2 synchronous kill-EPERM Auditor probe is finite explicitly unjoined, never spawn-failed or falsely closed', async () => {
  jest.useFakeTimers(); const child = new Child(); const labels: string[] = [];
  child.kill.mockImplementation(() => { child.fail('EPERM'); return false; });
  const result = executeCapturedLogs('owned', [], process.cwd(), 10, new AbortController().signal,
    { spawn: () => child, unjoined: (label) => labels.push(label) }).catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(10); child.fail('EACCES'); await jest.advanceTimersByTimeAsync(1999);
  expect(child.closed).toBe(false); expect(labels).toEqual([]);
  await jest.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ reason: 'qualification_log_child_unjoined', firstCause: 'qualification_log_deadline', unjoined: true });
  expect(labels).toEqual(['log_child_close']); expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  expect(() => child.fail('EPERM')).not.toThrow(); child.close(); expect(jest.getTimerCount()).toBe(0);
});

test('genuine no-child ENOENT is classified safely but close is still joined', async () => {
  jest.useFakeTimers(); const child = new Child(); child.pid = undefined; let settled = false;
  const result = executeCapturedLogs('missing', [], process.cwd(), 100, new AbortController().signal, { spawn: () => child })
    .catch((error: unknown) => { settled = true; return error; });
  child.fail('ENOENT'); await jest.advanceTimersByTimeAsync(0); expect(settled).toBe(false); child.close();
  expect(await result).toMatchObject({ reason: 'qualification_spawn_failed' }); expect(child.kill).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test('abort and throwing kill/report sinks cannot bypass finite unjoined tracking or replace first safe cause', async () => {
  jest.useFakeTimers(); const child = new Child(); const controller = new AbortController();
  child.kill.mockImplementation(() => { throw new Error('private kill error'); });
  const result = executeCapturedLogs('owned', [], process.cwd(), 100, controller.signal,
    { spawn: () => child, unjoined: () => { throw new Error('report-error'); } }).catch((error: unknown) => error);
  controller.abort(); await jest.advanceTimersByTimeAsync(2000);
  expect(await result).toMatchObject({ reason: 'qualification_log_child_unjoined', firstCause: 'qualification_stopping', unjoined: true });
  child.close(); expect(jest.getTimerCount()).toBe(0);
});

test('Commands records child-unjoined failure even when the executor settles before its outer timeout', async () => {
  jest.useFakeTimers(); const child = new Child(); child.kill.mockImplementation(() => { child.fail('EPERM'); return false; });
  const receipt = new Receipts('/tmp/opencode', '5c2ea80b79d4'); jest.spyOn(receipt, 'save').mockResolvedValue();
  const commands = new Commands(process.cwd(), receipt, async (_binary, _args, _cwd, _ms, signal, unjoined) =>
    executeCapturedLogs('owned', [], process.cwd(), 10, signal, { spawn: () => child, ...(unjoined ? { unjoined } : {}) }));
  commands.beginCleanup();
  const result = commands.docker('collect_owned_logs', ['container', 'logs', '--tail', '200', 'owned'], new AbortController().signal, 5000)
    .catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(2010);
  expect(await result).toMatchObject({ reason: 'qualification_log_child_unjoined' });
  expect(receipt.unjoinedOperations).toContain('collect_owned_logs_log_child_close');
  expect(receipt.commands[0]).toMatchObject({ code: null, failureKind: 'qualification_log_child_unjoined', firstFailureKind: 'qualification_log_deadline' });
  commands.closeFence(); child.close(); expect(jest.getTimerCount()).toBe(0);
});

test.each(['spawn_event_without_pid', 'pid_without_spawn_event'])('%s post-start error never becomes no-child spawnfailure', async (mode) => {
  const child = new Child(); if (mode === 'spawn_event_without_pid') child.pid = undefined;
  const result = executeCapturedLogs('owned', [], process.cwd(), 1000, new AbortController().signal, { spawn: () => child }).catch((error: unknown) => error);
  if (mode === 'spawn_event_without_pid') child.emit('spawn');
  child.fail('ENOENT'); child.close(); expect(await result).toMatchObject({ reason: 'qualification_log_process_error' });
});

test('outer timeout still records original late child-unjoined rejection, not a hidden settled task', async () => {
  jest.useFakeTimers(); const child = new Child(); child.kill.mockImplementation(() => { child.fail('EPERM'); return false; });
  const receipt = new Receipts('/tmp/opencode', '5c2ea80b79d4'); jest.spyOn(receipt, 'save').mockResolvedValue();
  const commands = new Commands(process.cwd(), receipt, async (_binary, _args, _cwd, _ms, signal, unjoined) =>
    executeCapturedLogs('owned', [], process.cwd(), 10, signal, { spawn: () => child, ...(unjoined ? { unjoined } : {}) }));
  commands.beginCleanup();
  const result = commands.docker('collect_owned_logs', ['container', 'logs', '--tail', '200', 'owned'], new AbortController().signal, 20)
    .catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(20); expect(await result).toBeInstanceOf(Error);
  expect(receipt.unjoinedOperations).toContain('collect_owned_logs');
  await jest.advanceTimersByTimeAsync(1990);
  expect(receipt.unjoinedOperations).toContain('collect_owned_logs_log_child_close');
  expect(receipt.unjoinedOperations).toContain('collect_owned_logs_late_rejection');
  commands.closeFence(); child.close(); expect(jest.getTimerCount()).toBe(0);
});

test('late close cannot succeed when monotonic deadline elapsed but timer delivery was delayed', async () => {
  const child = new Child(); let now = 0;
  const result = executeCapturedLogs('owned', [], process.cwd(), 1000, new AbortController().signal, { spawn: () => child, now: () => now })
    .catch((error: unknown) => error);
  now = 1000; child.close(); expect(await result).toMatchObject({ reason: 'qualification_log_deadline' });
});
