import { spawn } from 'node:child_process';
import { budgets, QualificationError } from './plan';
import { sha256, type Receipts, type ResourceObservation } from './receipts';
import { within } from './cancellation';
import { executeCapturedLogs } from './logProcess';
import { logLimits, type CapturedLogs } from './logCapture';
import type { Unjoined } from './cancellation';
import { LogChildUnjoined } from './logChildLifecycle';

export interface CommandResult { code: number | null; signal: string | null; stdout: string; stderr: string; logs?: CapturedLogs }
export type Executor = (binary: 'docker' | 'git', args: readonly string[], cwd: string, milliseconds: number,
  signal: AbortSignal, unjoined?: Unjoined) => Promise<CommandResult>;

export const executeCommand: Executor = (binary, args, cwd, milliseconds, signal, unjoined) => {
  if (binary === 'docker' && args[0] === 'container' && args[1] === 'logs' && args[2] === '--tail'
    && args[3] === String(logLimits.tailLines) && args.length === 5) return executeCapturedLogs(binary, args, cwd, milliseconds, signal, unjoined ? { unjoined } : {});
  return executeBufferedCommand(binary, args, cwd, milliseconds, signal);
};

export function executeBufferedCommand(binary: string, args: readonly string[], cwd: string, milliseconds: number,
  signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new QualificationError('qualification_stopping')); return; }
  const child = spawn(binary, [...args], { cwd, shell: false, env: { ...process.env, DOCKER_BUILDKIT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  let bytes = 0; let refused = false; let killing: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    refused = true; child.kill('SIGTERM');
    killing ??= setTimeout(() => child.kill('SIGKILL'), 2000);
  };
  const timer = setTimeout(stop, milliseconds);
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > budgets.commandBytes) stop();
    else target.push(chunk);
  };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
  child.once('error', () => {
    clearTimeout(timer); if (killing) clearTimeout(killing); signal.removeEventListener('abort', stop);
    reject(new QualificationError('qualification_spawn_failed'));
  });
  child.once('close', (code, termination) => {
    clearTimeout(timer); if (killing) clearTimeout(killing); signal.removeEventListener('abort', stop);
    if (refused) { reject(new QualificationError('qualification_command_deadline_or_capacity')); return; }
    resolve({ code, signal: termination, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
  });
  signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
  });
}

export class Commands {
  private mode: 'running' | 'cleanup' | 'closed' = 'running';
  constructor(readonly cwd: string, private readonly receipt: Receipts, private readonly executor: Executor = executeCommand) {}

  assertRunning(): void {
    if (this.mode !== 'running') throw new QualificationError('runner_admission_fenced');
  }

  beginCleanup(): void {
    if (this.mode === 'closed') return;
    this.mode = 'cleanup';
    for (const resource of this.receipt.resources) if (resource.creation === 'in_flight') resource.creation = 'uncertain';
  }

  closeFence(): void { this.mode = 'closed'; }

  private allowed(operation: string, args: readonly string[]): void {
    const cleanup = ['inspect_container', 'inspect_image', 'inspect_volume', 'inspect_network', 'stop_owned_container',
      'remove_owned_resource', 'collect_owned_logs'];
    if (this.mode === 'closed' || (this.mode === 'cleanup' && !cleanup.includes(operation))) {
      throw new QualificationError('runner_admission_fenced');
    }
    if (this.mode !== 'cleanup') return;
    const inspect = operation === `inspect_${args[0]}` && args[1] === 'inspect' && args.length === 3;
    const stop = operation === 'stop_owned_container' && args[0] === 'container' && args[1] === 'stop'
      && args[2] === '--time' && args[3] === '12' && args.length === 5;
    const remove = operation === 'remove_owned_resource' && ['container', 'image', 'volume', 'network'].includes(args[0] ?? '')
      && args[1] === 'rm' && args.length === 3;
    const logs = operation === 'collect_owned_logs' && args[0] === 'container' && args[1] === 'logs'
      && args[2] === '--tail' && args[3] === String(logLimits.tailLines) && args.length === 5;
    if (!inspect && !stop && !remove && !logs) throw new QualificationError('runner_admission_fenced');
  }

  async docker(operation: string, args: readonly string[], signal: AbortSignal, milliseconds: number = budgets.commandMs,
    allowFailure = false, creation?: ResourceObservation): Promise<CommandResult> {
    this.allowed(operation, args);
    const started = performance.now();
    if (this.receipt.commands.length >= 2000) throw new QualificationError('qualification_command_capacity');
    let result: CommandResult;
    try {
      result = await within(operation, () => {
        this.allowed(operation, args);
        if (creation) creation.creation = 'in_flight';
        return this.executor('docker', args, this.cwd, milliseconds, signal, (label) => this.receipt.unjoinedOperations.push(`${operation}_${label}`));
      }, signal, started + milliseconds, (label) => this.receipt.unjoinedOperations.push(label), async () => {
        if (creation) { creation.lateCompletionObserved = true; creation.creation = 'uncertain'; }
        await this.receipt.save();
      });
    }
    catch (error) {
      if (error instanceof LogChildUnjoined && !this.receipt.unjoinedOperations.includes(`${operation}_log_child_close`)) {
        this.receipt.unjoinedOperations.push(`${operation}_log_child_close`);
      }
      this.receipt.commands.push({ operation, code: null, signal: null, elapsedMs: Math.round(performance.now() - started),
        stdoutSha256: sha256(''), stderrSha256: sha256(''), failureKind: commandFailure(error),
        ...(error instanceof LogChildUnjoined ? { firstFailureKind: commandFailure(new QualificationError(error.firstCause)) } : {}) });
      if (creation?.creation === 'in_flight') creation.creation = 'uncertain';
      if (operation === 'build_owned_image' && creation?.creation === 'uncertain') this.receipt.provenance.buildDaemonCompletion = 'unproven_after_cli_failure';
      await this.receipt.save(); throw error;
    }
    this.receipt.commands.push({ operation, code: result.code, signal: result.signal,
      elapsedMs: Math.round(performance.now() - started), stdoutSha256: result.logs?.stdoutSha256 ?? sha256(result.stdout),
      stderrSha256: result.logs?.stderrSha256 ?? sha256(result.stderr) });
    if (creation) creation.creation = this.mode === 'running' && creation.creation !== 'uncertain' && result.code === 0 && !result.signal
      ? 'confirmed' : 'uncertain';
    await this.receipt.save();
    if (!allowFailure && (result.code !== 0 || result.signal)) throw new QualificationError('qualification_docker_command_failed');
    return result;
  }
}

export function commandFailure(error: unknown): string {
  const allowed = ['qualification_stopping', 'qualification_spawn_failed', 'qualification_command_deadline_or_capacity',
    'qualification_log_input_capacity', 'qualification_log_output_capacity', 'qualification_log_deadline', 'qualification_log_stream_failed',
    'qualification_docker_command_failed', 'qualification_log_signal_failed', 'qualification_log_process_error', 'qualification_log_child_unjoined'];
  try {
    const reason: unknown = error instanceof QualificationError ? Object.getOwnPropertyDescriptor(error, 'reason')?.value : undefined;
    return typeof reason === 'string' && allowed.includes(reason) ? reason : 'qualification_command_failed';
  } catch { return 'qualification_command_failed'; }
}
