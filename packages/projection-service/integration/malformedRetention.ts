import { QualificationError } from './plan';
import { assert, integer, record, isRecord } from './schema';
import { startupFacts } from './startupEvidence';
import type { MalformedPublication } from './transportFaults';
import { RetentionBudget, type RetentionBudgetOptions } from './retentionBudget';

export function obligation(value: unknown) {
  const queue = record(value);
  return { ready: integer(queue.messages_ready), unacked: integer(queue.messages_unacknowledged), ack: integer(record(queue.message_stats).ack) };
}

export function assertIsolated(value: unknown): number {
  const state = obligation(value); assert(state.ready === 0 && state.unacked === 0, 'malformed_baseline_not_empty');
  return state.ack;
}

export function assertRetained(value: unknown, before: number): ReturnType<typeof obligation> {
  const state = obligation(value); assert(state.ack === before, 'malformed_delivery_acked');
  assert(state.ready + state.unacked === 1, 'malformed_obligation_not_retained'); return state;
}

export interface MalformedPort {
  queue(signal?: AbortSignal): Promise<unknown>;
  health(path?: string, signal?: AbortSignal): Promise<unknown>;
  control(signal?: AbortSignal): Promise<{ runState: string }>;
  publish(signal?: AbortSignal): Promise<MalformedPublication>;
  stop(signal?: AbortSignal): Promise<number>;
  observe(facts: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
}

function numericFact(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? { shape: 'integer', value }
    : { shape: value === undefined ? 'absent' : 'invalid' };
}

export function retentionFacts(health: unknown, queue: unknown) {
  const value = isRecord(queue) ? queue : {}; const response = isRecord(health) ? health : {};
  const body = isRecord(response.body) ? response.body : {};
  const reasons = ['worker_paused', 'session_invalid', 'cleanup_failed', 'startup_refused', 'restart_reconciliation_required', 'none'];
  return { ready: numericFact(value.messages_ready), unacked: numericFact(value.messages_unacknowledged),
    ack: numericFact(isRecord(value.message_stats) ? value.message_stats.ack : undefined), status: numericFact(response.status),
    reason: reasons.find((reason) => reason === body.reason) ?? 'unknown', startup: startupFacts(body),
    workerPaused: body.reason === 'worker_paused', liveConsumerReady: body.liveConsumerReady === true,
    consumerDetails: Array.isArray(value.consumer_details) && value.consumer_details.length <= 16
      ? { shape: 'array', count: value.consumer_details.length } : { shape: value.consumer_details === undefined ? 'absent' : 'invalid' } };
}

function idleDetails(queue: unknown): boolean {
  const details = record(queue).consumer_details;
  if (!Array.isArray(details) || details.length > 16) throw new QualificationError('malformed_consumer_details_invalid');
  return details.length === 0;
}

async function waitRetained(port: MalformedPort, before: number, budget: RetentionBudget, stopped = false) {
  await budget.poll(async () => {
    const health = stopped ? undefined : record(await port.health());
    const queue = await port.queue();
    await port.observe({ phase: stopped ? 'after_stop' : 'paused_retention', ...retentionFacts(health, queue) });
    const state = obligation(queue);
    const idle = !stopped || idleDetails(queue);
    assert(state.ack === before, 'malformed_delivery_acked');
    assert(state.ready + state.unacked <= 1, 'malformed_obligation_ambiguous');
    return state.ready + state.unacked === 1 && (stopped ? state.ready === 1 && state.unacked === 0 && idle
      : health?.status === 503 && record(health.body).phase === 'paused' && record(health.body).reason === 'worker_paused'
        && record(health.body).liveConsumerReady === false);
  });
  const final = await port.queue();
  await port.observe({ phase: stopped ? 'after_stop_final' : 'paused_final', ...retentionFacts(undefined, final) });
  const retained = assertRetained(final, before);
  if (stopped) assert(retained.ready === 1 && retained.unacked === 0 && idleDetails(final), 'malformed_stop_obligation_not_ready');
  return retained;
}

async function verifyWithinBudget(port: MalformedPort, budget: RetentionBudget) {
  const baseline = await port.queue(); await port.observe({ phase: 'empty_baseline', ...retentionFacts(undefined, baseline) });
  const before = assertIsolated(baseline); const publication = await port.publish();
  await port.observe({ phase: 'confirmed_publication', publication });
  const paused = await waitRetained(port, before, budget);
  assert(record(await port.health('/live')).status === 200, 'paused_host_not_live');
  assertRetained(await port.queue(), before);
  assert((await port.control()).runState === 'active', 'unsafe_clean_restart_marker');
  assert(await port.stop() === 0, 'paused_shutdown_failed');
  const stopped = await waitRetained(port, before, budget, true);
  assert((await port.control()).runState === 'active', 'unsafe_clean_restart_marker');
  return { noAckAtObservedPause: true, rawTransportFixtureNotActualAppend: true, durableRunQuarantined: true,
    isolatedEmptyBaseline: true, beforeAckCount: before, paused, afterStop: stopped, publication, retainedObligations: 1, stoppedExitCode: 0,
    identityEvidence: 'isolated_single_confirmed_transport_publication_not_per_message_broker_peek' };
}

export async function verifyMalformedRetention(port: MalformedPort, signal: AbortSignal, options: RetentionBudgetOptions = {}) {
  const budget = new RetentionBudget(signal, options);
  try { const result = await verifyWithinBudget(budget.wrap(port), budget); budget.check(); return result; }
  finally { budget.close(); }
}
