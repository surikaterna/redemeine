import { spawnSync } from 'node:child_process';
import { waitForRabbitApp, type ProbeCommand } from '../scripts/topology-app-ready.cjs';
import { BrokerUnavailableError, type RestartEvidence } from './topologyPhase';

function probe(container: string, command: ProbeCommand, timeoutMs: number): { code: number | null; status: string } {
  const result = spawnSync('docker', ['exec', container, 'rabbitmq-diagnostics', '-q', command], {
    encoding: 'utf8', timeout: timeoutMs
  });
  return { code: result.error ? null : result.status, status: result.error ? 'probe-error' : 'exit' };
}

function exited(container: string): boolean {
  const result = spawnSync('docker', ['container', 'inspect', container, '--format', '{{json .State}}'], {
    encoding: 'utf8', timeout: 5_000
  });
  if (result.status !== 0) return true;
  try {
    const value: unknown = JSON.parse(result.stdout);
    return typeof value !== 'object' || value === null || !('Status' in value) ||
      (value.Status !== 'running' && value.Status !== 'restarting');
  } catch { return true; }
}

export async function waitForOwnedRabbitApp(container: string, deadlineMs: number): Promise<void> {
  await waitForRabbitApp({ probe: (command, timeoutMs) => Promise.resolve(probe(container, command, timeoutMs)),
    isExited: () => Promise.resolve(exited(container)), deadlineMs, probeMs: 5_000, delayMs: 500 });
}

export class BrokerGate {
  private unavailable = false;
  private restartEvidence: RestartEvidence = { restartSubphase: 'docker-restart', restartDocker: false,
    restartApp: false, restartAmqp: false, amqpErrorClass: 'none', amqpCode: null };

  get evidence(): RestartEvidence { return { ...this.restartEvidence }; }

  recordAmqpFailure(error: unknown): void {
    this.restartEvidence = { ...this.restartEvidence, ...classifyAmqpFailure(error) };
  }

  async afterRestart(restart: () => Promise<void>, appReady: () => Promise<void>, amqpReady: () => Promise<void>): Promise<void> {
    try {
      await restart();
      this.restartEvidence = { ...this.restartEvidence, restartDocker: true, restartSubphase: 'app-ready' };
      await appReady();
      this.restartEvidence = { ...this.restartEvidence, restartApp: true, restartSubphase: 'amqp-connect' };
      await amqpReady();
      this.restartEvidence = { ...this.restartEvidence, restartAmqp: true, amqpErrorClass: 'none', amqpCode: null };
    } catch (error) {
      if (this.restartEvidence.restartSubphase === 'amqp-connect' && this.restartEvidence.amqpErrorClass === 'none') {
        this.recordAmqpFailure(error);
      }
      this.unavailable = true;
      const failure = Object.assign(new Error('broker restart unavailable'), { restartEvidence: this.evidence });
      failure.name = this.restartEvidence.amqpErrorClass === 'ETIMEDOUT' || /timeout|timed out|deadline/i.test(errorMessage(error)) ?
        'BrokerRestartTimeoutError' : 'BrokerRestartError';
      throw failure;
    }
  }

  async beforeNegative(appReady: () => Promise<void>): Promise<void> {
    if (this.unavailable) throw new BrokerUnavailableError(this.evidence);
    try { await appReady(); }
    catch {
      this.unavailable = true;
      this.restartEvidence = { ...this.restartEvidence, restartSubphase: 'app-ready', restartApp: false,
        amqpErrorClass: 'none', amqpCode: null };
      throw new BrokerUnavailableError(this.evidence);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function classifyAmqpFailure(error: unknown): Pick<RestartEvidence, 'amqpErrorClass' | 'amqpCode'> {
  const value = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const code = value.code;
  const numeric = code === 403 || value.replyCode === 403 ? 403 : null;
  const text = errorMessage(error);
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(text)) return { amqpErrorClass: 'ECONNREFUSED', amqpCode: numeric };
  if (code === 'ETIMEDOUT' || /ETIMEDOUT|timed out|timeout|deadline/i.test(text)) return { amqpErrorClass: 'ETIMEDOUT', amqpCode: numeric };
  if (numeric === 403 || /ACCESS_REFUSED/i.test(text)) return { amqpErrorClass: 'ACCESS_REFUSED', amqpCode: numeric };
  if (/auth|login|credential|PLAIN/i.test(text)) return { amqpErrorClass: 'auth-failure', amqpCode: numeric };
  if (/channel.*clos|clos.*channel|connection.*clos/i.test(text)) return { amqpErrorClass: 'channel-close', amqpCode: numeric };
  return { amqpErrorClass: 'unknown', amqpCode: numeric };
}
