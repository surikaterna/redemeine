import { spawn } from 'node:child_process';
import type { CommandResult } from './commands';
import { LogCapture } from './logCapture';
import { QualificationError } from './plan';
import { LogChildLifecycle, type LogChildHandle } from './logChildLifecycle';
import type { Readable } from 'node:stream';
import type { Unjoined } from './cancellation';

export interface LogProcessChild extends LogChildHandle { stdout: Readable; stderr: Readable }
export interface LogProcessDependencies {
  spawn?: (binary: string, args: readonly string[], cwd: string) => LogProcessChild;
  unjoined?: Unjoined;
  now?: () => number;
}

function createChild(binary: string, args: readonly string[], cwd: string): LogProcessChild {
  return spawn(binary, [...args], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function executeCapturedLogs(binary: string, args: readonly string[], cwd: string, milliseconds: number,
  signal: AbortSignal, dependencies: LogProcessDependencies = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new QualificationError('qualification_stopping')); return; }
    let child: LogProcessChild;
    try { child = (dependencies.spawn ?? createChild)(binary, args, cwd); }
    catch { reject(new QualificationError('qualification_spawn_failed')); return; }
    const capture = new LogCapture(); const lifecycle = new LogChildLifecycle(child, milliseconds, signal, dependencies.unjoined, dependencies.now);
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (lifecycle.refused) return;
      try { capture.push(stream, chunk); }
      catch { lifecycle.stop('qualification_log_input_capacity'); }
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.stdout.on('error', () => lifecycle.stop('qualification_log_stream_failed'));
    child.stderr.on('error', () => lifecycle.stop('qualification_log_stream_failed'));
    void lifecycle.result.then(({ code, signal: termination }) => {
      try {
        const logs = capture.result(); resolve({ code, signal: termination, stdout: logs.body, stderr: '', logs });
      } catch { reject(new QualificationError('qualification_log_output_capacity')); }
    }, reject);
  });
}
