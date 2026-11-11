import { createHash, randomUUID } from 'node:crypto';
import type { LiveBrokerStartRecord } from '@redemeine/projection-runtime-core';
import type { RuntimeIdentity } from '../runtimeRegistry';
import type { ExternalConfig } from './mongo';
import { BrokerRefusal, object, same, string } from './brokerSchema';
import { liveQueueName } from './rabbitChannel';

export interface BootstrapRecord {
  readonly _id: string;
  readonly version: 1;
  readonly state: 'prepared' | 'bound';
  readonly epoch: string;
  readonly queueNonce: string;
  readonly generation: string;
  readonly registryDigest: string;
  readonly artifactDigest: string;
  readonly configDigest: string;
  readonly scopeDigest: string;
  readonly runState: 'clean' | 'active';
  readonly runId: string | null;
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function endpoint(uri: string): string { const url = new URL(uri); url.username = ''; url.password = ''; url.search = ''; return url.href; }

export function bootstrapIdentity(config: ExternalConfig, artifact: RuntimeIdentity) {
  const external = config.external;
  const url = new URL(external.rabbitmqUri);
  const broker = { endpoint: `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'amqps:' ? '5671' : '5672')}`,
    vhost: external.vhost, queue: liveQueueName };
  const scope = { collection: external.collection, partitionId: external.partitionId, tenant: external.tenant ?? null };
  return { _id: hash(broker), registryDigest: artifact.registryDigest, artifactDigest: artifact.digest, scopeDigest: hash(scope),
    configDigest: hash({ broker, scope, source: endpoint(external.mongodbUri), database: external.database,
      exchange: external.exchange, consumerUser: decodeURIComponent(url.username) || 'guest',
      management: external.managementUrl, managementUser: external.managementUsername,
      healthPort: config.healthPort, connectTimeoutMs: config.connectTimeoutMs, shutdownTimeoutMs: config.shutdownTimeoutMs,
      reconnectAttempts: config.reconnectAttempts, continuationDelayMs: config.continuationDelayMs, budget: config.budget }) };
}

export function preparedRecord(identity: ReturnType<typeof bootstrapIdentity>): BootstrapRecord {
  const epoch = randomUUID();
  return Object.freeze({ ...identity, version: 1, state: 'prepared', epoch, queueNonce: randomUUID(),
    generation: `broker:${epoch}`, runState: 'clean', runId: null });
}

export function validateBootstrap(value: unknown, identity: ReturnType<typeof bootstrapIdentity>): BootstrapRecord {
  const row = object(value);
  for (const [key, expected] of Object.entries(identity)) same(row[key], expected, 'bootstrap_identity_mismatch');
  if (row.version !== 1 || (row.state !== 'prepared' && row.state !== 'bound')
    || (row.runState !== 'clean' && row.runState !== 'active')) throw new BrokerRefusal('bootstrap_record_invalid');
  const epoch = string(row.epoch, 36);
  const queueNonce = string(row.queueNonce, 36);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(epoch) || !uuid.test(queueNonce) || (row.runId !== null && !uuid.test(string(row.runId, 36)))) {
    throw new BrokerRefusal('bootstrap_record_invalid');
  }
  same(row.generation, `broker:${epoch}`, 'bootstrap_generation_mismatch');
  if (row.runState === 'active' && (row.state !== 'bound' || row.runId === null)) throw new BrokerRefusal('bootstrap_record_invalid');
  return Object.freeze({ ...identity, version: 1, state: row.state, epoch, queueNonce, generation: `broker:${epoch}`,
    runState: row.runState, runId: row.runId === null ? null : string(row.runId, 36) });
}

export function brokerStart(record: BootstrapRecord, config: ExternalConfig): LiveBrokerStartRecord {
  return Object.freeze({ mode: 'LIVE_FROM_QUEUE_BINDING', epoch: record.epoch, queueName: liveQueueName,
    vhost: config.external.vhost, bindingRef: record.queueNonce, provisioningRef: record._id, registryDigest: record.registryDigest,
    generation: record.generation, sourceScopeDigest: record.scopeDigest, queueNonce: record.queueNonce,
    publisherContract: Object.freeze({ ordering: 'external_single_ordered_publisher', recoveryPolicy: 'external_best_effort_on_expiry',
      historicalCompleteness: 'unknown' }) });
}
