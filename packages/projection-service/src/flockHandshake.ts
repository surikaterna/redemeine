import { spawn, type ChildProcess } from 'node:child_process';

export type FlockSpawner = (fd: number) => ChildProcess;

function spawnFlock(fd: number): ChildProcess {
  return spawn('/usr/bin/flock', ['-n', '-E73', '3'], { shell: false,
    stdio: ['ignore', 'ignore', 'ignore', fd], env: {} });
}

/** The helper and parent share one open description; successful helper exit does not unlock it. */
export function flockHandshake(fd: number, signal: AbortSignal, start: FlockSpawner = spawnFlock): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try { child = start(fd); } catch { resolve(1); return; }
    let failed = false;
    let settled = false;
    const abort = () => { child.kill('SIGKILL'); };
    child.once('error', () => { failed = true; });
    child.once('close', (code, termination) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(failed || termination !== null || signal.aborted ? 1 : code === 0 ? 0 : code === 73 ? 73 : 1);
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
