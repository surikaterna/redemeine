import { spawnSync } from 'node:child_process';
import { waitForRabbitApp, type ProbeCommand } from '../scripts/topology-app-ready.cjs';
import { BrokerUnavailableError } from './topologyPhase';

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

  async afterRestart(restart: () => Promise<void>, appReady: () => Promise<void>, amqpReady: () => Promise<void>): Promise<void> {
    try { await restart(); await appReady(); await amqpReady(); }
    catch (error) { this.unavailable = true; throw error; }
  }

  async beforeNegative(appReady: () => Promise<void>): Promise<void> {
    if (this.unavailable) throw new BrokerUnavailableError();
    try { await appReady(); }
    catch { this.unavailable = true; throw new BrokerUnavailableError(); }
  }
}
