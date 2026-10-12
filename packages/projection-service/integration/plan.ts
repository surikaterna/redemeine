export const issueId = 'redemeine-hpq1.1';
export const publisherRevision = 'c2b657cb00dde60271e235dec917a7fee28d92f0';
export const exchangeName = 'tapeworm.master.commits';
export const queueName = 'rdm.projection.commits';
export const sourceCollection = 'commits';
export const partitionId = 'master';
export const producerFeedEnvironment = Object.freeze({ EXCHANGE: exchangeName, COLLECTION: sourceCollection });
export const projectionFeedEnvironment = Object.freeze({ RABBITMQ_EXCHANGE: exchangeName,
  MONGODB_COMMITS_COLLECTION: sourceCollection, PROJECTION_PARTITION_ID: partitionId });
export const qualificationNetwork = Object.freeze({ mode: 'owned_bridge_loopback_nat', driver: 'bridge', internal: false,
  egressAllowed: true, hostBindings: '127.0.0.1_only', productionQualification: false });
export const publisherStateCollection = 'tw_dispatcher_state';
export const publisherCheckpointKey = 'hpq1_checkpoint';
export const publisherUsername = 'hpq1_publisher';
export function publisherFeed(runId: string): string {
  validateRunId(runId);
  return JSON.stringify([`hpq1_${runId}`, `hpq1_${runId}`, sourceCollection, 'changeStream', exchangeName, null]);
}
export const images = Object.freeze({ mongo: 'mongo:8.0.17', rabbit: 'rabbitmq:4.1.4-management', node: 'node:24.20.0-bookworm-slim',
  publisherBase: 'node:26.9.0-alpine' });
export const budgets = Object.freeze({ buildMs: 900000, pullMs: 300000, commandMs: 20000, scenarioMs: 30000,
  stackMs: 240000, cleanupMs: 120000, commandBytes: 1048576, sourceContextBytes: 67108864,
  sourceContextFiles: 2000, mongoDiskBytes: 2147483648, inactiveSources: 256 });

export class QualificationError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

export function validateRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{12}$/.test(value)) throw new QualificationError('invalid_qualification_run_id');
  return value;
}

export function requireApproval(env: Readonly<Record<string, string | undefined>>, digest: string): string {
  if (env.HPQ1_ALLOW_DOCKER !== 'external-broker-live-v1-reviewed' || env.HPQ1_PREAUDIT_SHA256 !== digest
    || !/^[a-f0-9]{64}$/.test(digest)) throw new QualificationError('qualification_execution_not_approved');
  if (env.DOCKER_HOST || env.DOCKER_CONTEXT) throw new QualificationError('explicit_remote_docker_refused');
  return validateRunId(env.HPQ1_RUN_ID);
}

export function resourceName(runId: string, role: string): string {
  validateRunId(runId);
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(role)) throw new QualificationError('invalid_resource_role');
  return `hpq1-${runId}-${role}`;
}

export function assertLocalDaemon(host: unknown): void {
  if (typeof host !== 'string' || !/^unix:\/\/(\/var\/run\/docker\.sock|\/run\/user\/[0-9]+\/docker\.sock)$/.test(host)) {
    throw new QualificationError('nonlocal_docker_refused');
  }
}

export const scenarioCoverage = Object.freeze({
  policy_refusal: 'implemented', no_destination_checkpoint: 'implemented', first42_complete_commit: 'implemented',
  new_source: 'implemented', graceful_backlog_restart: 'implemented', native_resume_final_and_unseen: 'implemented',
  redelivery_over20: 'implemented_transport_fault', malformed_unacked: 'implemented_transport_fault',
  unclean_restart_pause: 'implemented', alternate_destination_confirm: 'not_implemented',
  expiry_pressure: 'not_implemented', delayed_server_write: 'not_implemented',
  deterministic_save_before_ack_crash: 'not_implemented', actual_gap_repair: 'not_implemented',
  actual_binding_drift: 'not_implemented', million_source_scale: 'not_implemented'
});
