import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
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

test('Linux timeout SIGKILLs a detached direct child and grandchild and joins close', async () => {
  if (process.platform !== 'linux') return;
  const code = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.error('grandchild='+child.pid);
    setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let grandchildPid: number | undefined;
  child.stderr.on('data', (data: Buffer) => {
    const match = data.toString().match(/grandchild=(\d+)/);
    if (match) grandchildPid = Number(match[1]);
  });
  try {
    await expect(awaitStackChild(child, 'linux-group', 300, Date.now, () => undefined))
      .rejects.toThrow('linux-group: child timeout');
    expect(child.signalCode).toBe('SIGKILL');
    expect(grandchildPid).toBeDefined();
    expect(processRunning(child.pid as number)).toBe(false);
    expect(processRunning(grandchildPid as number)).toBe(false);
  } finally {
    if (child.pid && processRunning(child.pid)) process.kill(-child.pid, 'SIGKILL');
    if (grandchildPid && processRunning(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
  }
});
