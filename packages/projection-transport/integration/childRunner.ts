import type { ChildProcess } from 'node:child_process';

export interface ChildOutcome {
  scenario: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  stderr: string;
}

/** A bounded stderr excerpt survives both a normal exit and a timed-out child. */
export function awaitStackChild(child: ChildProcess, scenario: string, timeoutMs: number,
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
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      child.stderr?.off('data', onData);
    };
    const fail = (reason: string): void => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(`${scenario}: ${reason}; elapsedMs=${now() - started}; stderr=${stderr}`));
    };
    const onError = (error: Error): void => fail(error.message);
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ scenario, code, signal, elapsedMs: now() - started, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (error) {
        fail(`child timeout and kill failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      fail('child timeout');
    }, timeoutMs);
    child.once('error', onError);
    child.once('close', onClose);
  });
}
