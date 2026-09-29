import type { ChildProcess } from 'node:child_process';
import { awaitChildReady, isCrashSignal, type CrashSignal } from './crashIpc';

export function observeChild(child: ChildProcess, combined: CrashSignal[]): (timeoutMs?: number) => Promise<CrashSignal> {
  const own: CrashSignal[] = [];
  child.on('message', (message: unknown) => {
    if (isCrashSignal(message)) { own.push(message); combined.push(message); }
  });
  return (timeoutMs) => awaitChildReady(child, own, timeoutMs);
}
