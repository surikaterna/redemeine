import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, expect, jest, test } from '@jest/globals';
import { awaitStackChild } from '../integration/childRunner';

class FakeChild extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly kill = jest.fn((signal: NodeJS.Signals) => {
    this.emit('close', null, signal);
    return true;
  });
}

afterEach(() => jest.useRealTimers());

test('a promptly exited child retains stderr and elapsed time without a live timeout', async () => {
  jest.useFakeTimers();
  const child = new FakeChild();
  const pending = awaitStackChild(child as unknown as ChildProcess, 'normal', 45_000, Date.now, () => undefined);
  jest.advanceTimersByTime(25);
  child.stderr.write('scenario diagnostic');
  child.emit('close', 0, null);
  await expect(pending).resolves.toMatchObject({ scenario: 'normal', code: 0, elapsedMs: 25, stderr: 'scenario diagnostic' });
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
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(jest.getTimerCount()).toBe(0);
});

function processRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.split(' ')[2] !== 'Z';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function waitForGrandchildReady(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = '';
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Child exited before grandchild was ready'));
    };
    const onData = (data: Buffer): void => {
      output += data.toString();
      const match = output.match(/ready=(\d+)\n/);
      if (match) {
        cleanup();
        resolve(Number(match[1]));
      }
    };
    // Bound startup separately; the 300ms timeout under test begins only after both handlers exist.
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Grandchild readiness handshake timed out'));
    }, 10_000);
    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

function killGroupIfPresent(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function joinChild(closed: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Child did not close after test cleanup')), 2_500);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('Linux timeout SIGKILLs a detached direct child and grandchild and joins close', async () => {
  if (process.platform !== 'linux') return;
  const grandchildCode = 'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)';
  const code = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>process.stderr.write('term=direct\\n'));
    const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:['ignore','pipe','ignore']});
    child.stdout.once('data',()=>process.stderr.write('ready='+child.pid+'\\n'));
    setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let grandchildPid: number | undefined;
  try {
    grandchildPid = await waitForGrandchildReady(child);
    await expect(awaitStackChild(child, 'linux-group', 300, Date.now, () => undefined)).rejects.toThrow(/linux-group: child timeout;.*term=direct/);
    expect(child.signalCode).toBe('SIGKILL');
    expect(processRunning(child.pid as number)).toBe(false);
    expect(processRunning(grandchildPid)).toBe(false);
  } finally {
    if (child.pid) killGroupIfPresent(child.pid);
    if (grandchildPid && processRunning(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
    await joinChild(closed);
  }
});
