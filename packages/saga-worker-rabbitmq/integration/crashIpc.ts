import type { ChildProcess } from 'node:child_process';
import { ChildStartupFailure, isChildError, type ChildError } from './crashChildStages';

export type CrashSignal = ChildError | { readonly kind: 'ready' | 'confirmed' | 'delivery' | 'processed' | 'ack' | 'dead';
  readonly messageId?: string; readonly redelivered?: boolean; readonly attempt?: number;
  readonly deaths?: unknown; readonly statuses?: readonly string[] };

export function isCrashSignal(value: unknown): value is CrashSignal {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  return value.kind === 'error' ? isChildError(value) :
    ['ready', 'confirmed', 'delivery', 'processed', 'ack', 'dead'].includes(String(value.kind));
}

export function awaitChildReady(child: ChildProcess, observed: readonly CrashSignal[], timeoutMs = 6_000): Promise<CrashSignal> {
  const error = observed.find(signal => signal.kind === 'error');
  if (error?.kind === 'error') return Promise.reject(new ChildStartupFailure(error));
  const ready = observed.find(signal => signal.kind === 'ready');
  if (ready && child.exitCode === null && child.signalCode === null) return Promise.resolve(ready);
  return awaitSignal(child, signal => signal.kind === 'ready', timeoutMs);
}

export function awaitSignal(child: ChildProcess, matches: (signal: CrashSignal) => boolean,
  timeoutMs = 15_000): Promise<CrashSignal> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('child IPC timed out')), timeoutMs);
    const onMessage = (value: unknown) => {
      if (!isCrashSignal(value)) return;
      if (value.kind === 'error') finish(new ChildStartupFailure(value));
      else if (matches(value)) finish(undefined, value);
    };
    const onExit = (code: number | null, _signal: NodeJS.Signals | null) =>
      finish(new ChildStartupFailure({ kind: 'error', phase: 'unknown', errorClass: 'exit',
        code: typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 && code <= 999 ? code : null }));
    const finish = (error?: Error, value?: CrashSignal) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const onError = () => finish(new Error('child failed before IPC'));
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

export function killOwned(child: ChildProcess, timeoutMs = 10_000): Promise<NodeJS.Signals> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(new Error('child already exited before SIGKILL'));
      return;
    }
    const timer = setTimeout(() => finish(new Error('SIGKILL exit timed out')), timeoutMs);
    const onExit = (_code: number | null, signal: NodeJS.Signals | null) =>
      signal === 'SIGKILL' ? finish(undefined, signal) : finish(new Error('child did not exit by SIGKILL'));
    const finish = (error?: Error, signal?: NodeJS.Signals) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      if (error) reject(error);
      else if (signal) resolve(signal);
    };
    child.on('exit', onExit);
    if (!child.kill('SIGKILL')) finish(new Error('SIGKILL could not be sent'));
  });
}
