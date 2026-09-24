import type { ChildProcess } from 'node:child_process';
import { reapChildGroup } from './childProcessGroup';

export interface ChildOutcome {
  scenario: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  stderr: string;
}

function closeOutcome(child: ChildProcess, scenario: string, now: () => number, started: number,
  stderr: () => string): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ scenario, code, signal, elapsedMs: now() - started, stderr: stderr() }));
  });
}

async function waitForClose(closed: Promise<ChildOutcome>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closed.then(() => undefined), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Child did not close after process-group termination.')), 2_500);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Preserve bounded stderr and await child reaping before reporting a timed-out scenario. */
export async function awaitStackChild(child: ChildProcess, scenario: string, timeoutMs: number,
  now: () => number = Date.now, writeStderr: (chunk: string) => void = (chunk) => process.stderr.write(chunk)
): Promise<ChildOutcome> {
  const started = now();
  let stderr = '';
  const onData = (value: Buffer | string): void => {
    const chunk = value.toString();
    writeStderr(chunk);
    stderr = `${stderr}${chunk}`.slice(-8_192);
  };
  child.stderr?.on('data', onData);
  const closed = closeOutcome(child, scenario, now, started, () => stderr);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    const outcome = await Promise.race([closed, deadline]);
    if (outcome === 'timeout') {
      const failures: string[] = [];
      try { await reapChildGroup(child, 250, true); } catch (error) { failures.push(String(error)); }
      try { await waitForClose(closed); } catch (error) { failures.push(String(error)); }
      throw new Error(`${scenario}: child timeout; elapsedMs=${now() - started}; stderr=${stderr}`
        + (failures.length ? `; cleanup=${failures.join(', ')}` : ''));
    }
    await reapChildGroup(child, 250);
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    child.stderr?.off('data', onData);
  }
}
