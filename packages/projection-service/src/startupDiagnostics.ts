import { MongoServerError } from 'mongodb';
import { BrokerRefusal } from './infrastructure/brokerSchema';
import { InfrastructureError } from './infrastructure/failure';
import { TransientConnectionError } from './reconnect';

export type StartupStage = 'none' | 'mongo_connection' | 'source_reader' | 'rabbit_connection' | 'rabbit_channel' | 'rabbit_identity' | 'binding'
  | 'store_initialization' | 'run_claim' | 'runtime_composition' | 'consumer_start';
export type StartupCode = 'none' | 'connection_transient' | 'broker_policy_unproven' | 'broker_schema_invalid'
  | 'broker_queue_response_invalid' | 'broker_queue_arguments_invalid' | 'broker_queue_effective_policy_invalid' | 'broker_queue_consumer_details_invalid'
  | 'broker_consumer_count_pending' | 'broker_consumer_count_inconsistent' | 'broker_consumer_activation_deadline'
  | 'broker_consumer_queue_mismatch' | 'broker_consumer_tag_mismatch' | 'broker_consumer_active_mismatch' | 'broker_consumer_ack_mismatch'
  | 'broker_consumer_exclusive_mismatch' | 'broker_consumer_prefetch_mismatch' | 'broker_consumer_arguments_mismatch'
  | 'broker_consumer_channel_mismatch' | 'broker_consumer_connection_mismatch' | 'broker_session_expired' | 'broker_session_mismatch' | 'broker_topology_stale'
  | 'broker_management_refused' | 'broker_management_unavailable' | 'broker_management_timeout' | 'broker_management_capacity'
  | 'broker_store_unready' | 'broker_identity_mismatch' | 'broker_channel_unidentified' | 'broker_binding_mismatch'
  | 'unregistered_queue' | 'established_queue_missing' | 'bootstrap_write_uncertain' | 'bootstrap_compare_failed'
  | 'restart_reconciliation_required' | 'broker_consumer_conflict' | 'broker_startup_refused' | 'broker_definition_mismatch'
  | 'mongo_prerequisite_failed' | 'rabbit_prerequisite_failed' | 'infrastructure_stopped' | 'infrastructure_cleanup_failed'
  | 'mongo_range_index_unready' | 'mongo_authentication_failed' | 'mongo_duplicate_key' | 'live_start_unproven' | 'broker_refused' | 'unknown_error';
export const startupCodes: readonly StartupCode[] = ['none', 'connection_transient', 'broker_policy_unproven', 'broker_schema_invalid',
  'broker_queue_response_invalid', 'broker_queue_arguments_invalid', 'broker_queue_effective_policy_invalid', 'broker_queue_consumer_details_invalid',
  'broker_consumer_count_pending', 'broker_consumer_count_inconsistent', 'broker_consumer_activation_deadline',
  'broker_consumer_queue_mismatch', 'broker_consumer_tag_mismatch', 'broker_consumer_active_mismatch', 'broker_consumer_ack_mismatch',
  'broker_consumer_exclusive_mismatch', 'broker_consumer_prefetch_mismatch', 'broker_consumer_arguments_mismatch',
  'broker_consumer_channel_mismatch', 'broker_consumer_connection_mismatch', 'broker_session_expired', 'broker_session_mismatch', 'broker_topology_stale',
  'broker_management_refused', 'broker_management_unavailable', 'broker_management_timeout', 'broker_management_capacity',
  'broker_store_unready', 'broker_identity_mismatch', 'broker_channel_unidentified', 'broker_binding_mismatch', 'unregistered_queue',
  'established_queue_missing', 'bootstrap_write_uncertain', 'bootstrap_compare_failed', 'restart_reconciliation_required',
  'broker_consumer_conflict', 'broker_startup_refused', 'broker_definition_mismatch', 'mongo_prerequisite_failed',
  'rabbit_prerequisite_failed', 'infrastructure_stopped', 'infrastructure_cleanup_failed', 'mongo_range_index_unready',
  'mongo_authentication_failed', 'mongo_duplicate_key', 'live_start_unproven', 'broker_refused', 'unknown_error'];
export const startupStages: readonly StartupStage[] = ['none', 'mongo_connection', 'source_reader', 'rabbit_connection', 'rabbit_channel', 'rabbit_identity', 'binding',
  'store_initialization', 'run_claim', 'runtime_composition', 'consumer_start'];
export type StartupHttpRoute = 'queue' | 'exchange' | 'bindings' | 'policy' | 'operator_policy' | 'connection' | 'other';
export const startupHttpRoutes: readonly StartupHttpRoute[] = ['queue', 'exchange', 'bindings', 'policy', 'operator_policy', 'connection', 'other'];

export type StartupObserver = (stage: StartupStage, error?: unknown) => void;

export function observeStartup(observer: StartupObserver | undefined, stage: StartupStage, error?: unknown): void {
  try {
    const returned: unknown = observer?.(stage, error);
    if (returned === undefined) return;
    try { void Promise.prototype.then.call(returned, undefined, () => {}); }
    catch { void Promise.resolve(returned).then(undefined, () => {}); }
  } catch { /* Diagnostics have no acquisition, failure or cleanup authority. */ }
}

export function startupCode(error: unknown): StartupCode {
  try { return classifyStartup(error); }
  catch { return 'unknown_error'; }
}

function classifyStartup(error: unknown): StartupCode {
  if (error instanceof TransientConnectionError) return 'connection_transient';
  if (error instanceof BrokerRefusal || error instanceof InfrastructureError) {
    return startupCodes.find((code) => code === error.reason) ?? 'broker_refused';
  }
  if (error instanceof MongoServerError && error.code === 18) return 'mongo_authentication_failed';
  if (error instanceof MongoServerError && error.code === 11000) return 'mongo_duplicate_key';
  if (error instanceof Error && error.message === 'Exactly one usable Tapeworm streamId/commitSequence index is required.') {
    return 'mongo_range_index_unready';
  }
  if (error instanceof Error && error.message === 'live_start_unproven') return 'live_start_unproven';
  return 'unknown_error';
}

export function startupHttpRoute(segments: readonly string[]): StartupHttpRoute {
  if (segments.includes('bindings')) return 'bindings';
  if (segments[0] === 'queues') return 'queue';
  if (segments[0] === 'exchanges') return 'exchange';
  if (segments[0] === 'policies') return 'policy';
  if (segments[0] === 'operator-policies') return 'operator_policy';
  if (segments[0] === 'connections') return 'connection';
  return 'other';
}
