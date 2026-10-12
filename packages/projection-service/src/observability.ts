import type { LiveCommitResult } from '@redemeine/projection-runtime-core';
import { startupCode, type StartupStage, type StartupCode, type StartupHttpRoute } from './startupDiagnostics';
import type { ConsumerFacts } from './infrastructure/consumerFacts';

export type HostPhase = 'configuring' | 'locked' | 'connecting' | 'reference_active' | 'external_active' | 'backoff' | 'paused' | 'stopping' | 'stopped';
export type HostReason = 'none' | 'ownership_denied' | 'ownership_contended' | 'connection_transient' | 'startup_refused'
  | 'startup_timeout' | 'channel_lost' | 'session_invalid' | 'worker_paused' | 'retry_exhausted' | 'shutdown'
  | 'shutdown_deadline' | 'cleanup_failed' | 'host_failed' | 'restart_reconciliation_required';

function bounded(value: number): number { return Number.isFinite(value) ? Math.min(1000000000, Math.max(0, value)) : 0; }

function turnReason(result: LiveCommitResult): string {
  const allowed = ['live_continuity_violation', 'live_work_capacity', 'live_payload_capacity', 'live_history_unavailable',
    'live_position_identity_conflict', 'unsupported_live_routing', 'marker_lifetime_violation', 'live_definition_failed'];
  if (result.status !== 'paused') return result.status;
  return result.reason && allowed.includes(result.reason) ? result.reason : 'turn_refused';
}

export class Observations {
  phase: HostPhase = 'configuring';
  reason: HostReason = 'none';
  owned = false;
  retries = 0;
  private commits = 0;
  private continuations = 0;
  private pauses = 0;
  private turnMilliseconds = 0;
  private lastTurnReason = 'none';
  private startupStage: StartupStage = 'none';
  private startupFailure: StartupCode = 'none';
  private startupHttp: { route: StartupHttpRoute; status: number; json: boolean } | undefined;
  private consumerSnapshot: ConsumerFacts | undefined;

  constructor(private readonly output: (line: string) => void = () => {}, private readonly mode: 'reference' | 'external' = 'reference') {}

  startup(stage: StartupStage, error?: unknown): void {
    this.startupStage = stage; this.startupFailure = error === undefined ? 'none' : startupCode(error);
  }

  consumer(facts: ConsumerFacts): void { this.consumerSnapshot = facts; }

  http(route: StartupHttpRoute, status: number | undefined, json: boolean): void {
    this.startupHttp = { route, status: status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0, json };
  }

  transition(phase: HostPhase, reason: HostReason = 'none'): void {
    this.phase = phase;
    this.reason = reason;
    // A broken observation sink must not bypass fencing or resource cleanup.
    try { this.output(JSON.stringify(this.snapshot(false))); } catch { /* Output has no admission authority. */ }
  }

  result(result: LiveCommitResult, milliseconds: number): void {
    this.lastTurnReason = turnReason(result);
    this.commits = bounded(this.commits + result.processedCommits);
    this.continuations = bounded(this.continuations + Number(result.status === 'continuation'));
    this.pauses = bounded(this.pauses + Number(result.status === 'paused'));
    this.turnMilliseconds = Number.isFinite(milliseconds) ? bounded(Math.round(milliseconds)) : 0;
  }

  snapshot(referenceReady: boolean, liveConsumerReady = false) {
    return { phase: this.phase, reason: this.reason, owned: this.owned, productionReady: this.mode === 'external' && liveConsumerReady,
      liveConsumerReady: this.mode === 'external' && liveConsumerReady, sourceHistoricalCompleteness: 'unknown',
      publisherRecoveryPolicy: this.mode === 'external' ? 'external_best_effort_on_expiry' : 'modeled',
      referenceOnly: this.mode === 'reference', referenceReady, retries: bounded(this.retries), processedCommits: this.commits,
      continuations: this.continuations, pausedTurns: this.pauses, lastTurnMilliseconds: this.turnMilliseconds, lastTurnReason: this.lastTurnReason,
      startupStage: this.startupStage, startupCode: this.startupFailure, ...(this.startupHttp ? {
        startupHttpRoute: this.startupHttp.route, startupHttpStatus: this.startupHttp.status, startupHttpJson: this.startupHttp.json } : {}),
       ...this.consumerSnapshot, publisherLag: 'unknown', cdcLag: 'unknown' };
  }
}
