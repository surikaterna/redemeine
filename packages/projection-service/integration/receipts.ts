import { createHash } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { issueId, QualificationError, scenarioCoverage } from './plan';
import type { PortObservation } from './portDiagnostics';
import { publisherLogFacts } from './publisherLogs';
import { startupCodes, startupStages, startupHttpRoutes } from '../src/startupDiagnostics';
import { consumerHealthFacts } from '../src/infrastructure/consumerFacts';

export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

export interface CommandObservation {
  operation: string; code: number | null; signal: string | null; elapsedMs: number; stdoutSha256: string; stderrSha256: string;
  failureKind?: string;
  firstFailureKind?: string;
}
export interface ResourceObservation {
  kind: 'container' | 'network' | 'volume' | 'image'; name: string; id?: string; removed: boolean;
  creation?: 'not_requested' | 'in_flight' | 'confirmed' | 'uncertain';
  lateCompletionObserved?: boolean; removalObserved?: boolean;
}

export class Receipts {
  readonly commands: CommandObservation[] = [];
  readonly resources: ResourceObservation[] = [];
  readonly portObservations: PortObservation[] = [];
  readonly scenarios: Array<{ name: string; outcome: 'pass' | 'fail'; evidence?: Record<string, unknown>; reason?: string }> = [];
  readonly provenance: Record<string, unknown> = {};
  readonly cleanupFailures: string[] = [];
  readonly unjoinedOperations: string[] = [];
  outcome: 'running' | 'pass' | 'fail' = 'running';
  private saves: Promise<void> = Promise.resolve();

  constructor(readonly root: string, readonly runId: string) {}

  async scenario(name: string, work: () => Promise<Record<string, unknown>>): Promise<void> {
    try { this.scenarios.push({ name, outcome: 'pass', evidence: await work() }); }
    catch (error) {
      this.scenarios.push({ name, outcome: 'fail', reason: error instanceof QualificationError ? error.reason : 'qualification_scenario_failed' });
      await this.save(); throw error;
    }
    await this.save();
  }

  save(): Promise<void> {
    const body = `${JSON.stringify({ issue: issueId, runId: this.runId, at: new Date().toISOString(), outcome: this.outcome,
      provenance: this.provenance, commands: this.commands, resources: this.resources, portObservations: this.portObservations, scenarios: this.scenarios,
      coverage: scenarioCoverage, cleanupFailures: this.cleanupFailures, unjoinedOperations: this.unjoinedOperations,
      limits: ['historical_completeness_unknown', 'unimplemented_faults_not_qualified', 'shared_base_images_and_build_cache_not_pruned'] }, null, 2)}\n`;
    this.saves = this.saves.then(async () => {
      const temporary = join(this.root, 'receipt.tmp');
      await writeFile(temporary, body, { mode: 0o600 }); await rename(temporary, join(this.root, 'receipt.json'));
    });
    return this.saves;
  }
}

const logKeys = ['phase', 'reason', 'owned', 'liveConsumerReady', 'sourceHistoricalCompleteness', 'publisherRecoveryPolicy',
   'processedCommits', 'retries', 'outcome', 'startupStage', 'startupCode', 'startupHttpRoute', 'startupHttpStatus', 'startupHttpJson'];
const logStrings = new Set(['configuring', 'locked', 'connecting', 'external_active', 'reference_active', 'backoff', 'paused',
    'stopping', 'stopped', 'none', 'shutdown', 'shutdown_deadline', 'startup_refused', 'restart_reconciliation_required',
     'session_invalid', 'worker_paused', 'channel_lost', 'retry_exhausted', 'cleanup_failed', 'unknown', 'external_best_effort_on_expiry',
      ...startupCodes, ...startupStages, ...startupHttpRoutes]);

function safeLog(value: object): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of logKeys) {
    const entry: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry))) safe[key] = entry;
    if (typeof entry === 'string' && logStrings.has(entry)) safe[key] = entry;
  }
  return { ...safe, ...consumerHealthFacts(value) };
}

export function sanitizedLogs(raw: string): string {
  const output: Record<string, unknown>[] = [];
  for (const line of raw.split('\n').slice(0, 200)) {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      output.push(safeLog(value));
    } catch { /* Unknown producer output is omitted, not persisted with guessed redaction. */ }
  }
  return `${JSON.stringify({ observations: output, publisherLifecycle: publisherLogFacts(raw), rawSha256: sha256(raw), unstructuredOutput: 'omitted' })}\n`;
}
