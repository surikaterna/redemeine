import type { LiveWorkBudget } from '@redemeine/projection-runtime-core';
import { ConfigError, connectionUri, integer, nameValue, type Environment } from './configValues';

export interface HostOptions {
  readonly mode: 'reference' | 'external';
  readonly execution: 'once' | 'serve';
  readonly queueName: 'rdm.projection.commits';
  readonly healthPort: number;
  readonly shutdownTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly reconnectAttempts: number;
  readonly continuationDelayMs: number;
  readonly budget: Readonly<LiveWorkBudget>;
}

export interface ExternalOptions {
  readonly mongodbUri: string;
  readonly database: string;
  readonly collection: string;
  readonly rabbitmqUri: string;
  readonly vhost: string;
  readonly exchange: string;
  readonly managementUrl: string;
  readonly managementUsername: string;
  readonly managementPassword: string;
  readonly partitionId: string;
  readonly tenant?: string;
}

export type HostConfig = Readonly<HostOptions & (
  { mode: 'reference' } | { mode: 'external'; external: Readonly<ExternalOptions> }
)>;

const externalKeys = ['MONGODB_URI', 'MONGODB_DATABASE', 'MONGODB_COMMITS_COLLECTION',
  'RABBITMQ_URI', 'RABBITMQ_VHOST', 'RABBITMQ_EXCHANGE', 'PROJECTION_PARTITION_ID', 'PROJECTION_TENANT',
  'RABBITMQ_MANAGEMENT_URL', 'RABBITMQ_MANAGEMENT_USERNAME', 'RABBITMQ_MANAGEMENT_PASSWORD'];
const commonKeys = ['PROJECTION_MODE', 'HEALTH_PORT', 'SHUTDOWN_TIMEOUT_MS', 'CONNECT_TIMEOUT_MS',
  'RECONNECT_ATTEMPTS', 'PROJECTION_MAX_COMMITS', 'PROJECTION_MAX_BYTES', 'PROJECTION_MAX_MILLISECONDS',
  'PROJECTION_MAX_EVENTS_PER_COMMIT', 'PROJECTION_CONTINUATION_DELAY_MS', 'PROJECTION_EXECUTION'];

function checkEnvironment(env: Environment): void {
  const allowed = new Set([...externalKeys, ...commonKeys]);
  for (const key of Object.keys(env)) {
    if (/^(PROJECTION_|MONGODB_|RABBITMQ_)/.test(key) && !allowed.has(key) && env[key] !== undefined) {
      throw new ConfigError('environment', 'unsupported_setting');
    }
  }
}

function externalOptions(env: Environment): Readonly<ExternalOptions> {
  const mongo = connectionUri(env, 'MONGODB_URI', ['mongodb:', 'mongodb+srv:']);
  const rabbit = connectionUri(env, 'RABBITMQ_URI', ['amqp:', 'amqps:']);
  const vhost = env.RABBITMQ_VHOST;
  if (!vhost || vhost.length > 128 || [...vhost].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new ConfigError('RABBITMQ_VHOST', 'invalid_vhost');
  }
  let uriVhost: string;
  try {
    uriVhost = decodeURIComponent(rabbit.pathname.slice(1)) || '/';
    decodeURIComponent(rabbit.username); decodeURIComponent(rabbit.password);
  }
  catch { throw new ConfigError('RABBITMQ_URI', 'invalid_vhost'); }
  if (uriVhost !== vhost) throw new ConfigError('RABBITMQ_VHOST', 'uri_mismatch');
  return Object.freeze({ mongodbUri: mongo.href, rabbitmqUri: rabbit.href, vhost, ...managementOptions(env),
    database: databaseName(env), collection: nameValue(env, 'MONGODB_COMMITS_COLLECTION'),
    exchange: nameValue(env, 'RABBITMQ_EXCHANGE'), partitionId: nameValue(env, 'PROJECTION_PARTITION_ID'),
    ...(env.PROJECTION_TENANT === undefined ? {} : { tenant: nameValue(env, 'PROJECTION_TENANT') }) });
}

function databaseName(env: Environment): string {
  const value = nameValue(env, 'MONGODB_DATABASE');
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(value)) throw new ConfigError('MONGODB_DATABASE', 'invalid_database_name');
  return value;
}

function managementOptions(env: Environment) {
  const url = connectionUri(env, 'RABBITMQ_MANAGEMENT_URL', ['http:', 'https:']);
  if (url.username || url.password || url.search || url.pathname !== '/'
    || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new ConfigError('RABBITMQ_MANAGEMENT_URL', 'https_or_loopback_origin_required');
  }
  const username = env.RABBITMQ_MANAGEMENT_USERNAME;
  const password = env.RABBITMQ_MANAGEMENT_PASSWORD;
  if (!username || username.length > 256 || username.includes(':') || [...username].some((c) => c.charCodeAt(0) < 32)) {
    throw new ConfigError('RABBITMQ_MANAGEMENT_USERNAME', 'invalid_credential');
  }
  if (!password || password.length > 4096 || [...password].some((c) => c.charCodeAt(0) < 32)) {
    throw new ConfigError('RABBITMQ_MANAGEMENT_PASSWORD', 'invalid_credential');
  }
  return { managementUrl: url.href, managementUsername: username, managementPassword: password };
}

function commonOptions(env: Environment): Omit<HostOptions, 'mode'> {
  const execution = env.PROJECTION_EXECUTION ?? 'once';
  if (execution !== 'once' && execution !== 'serve') throw new ConfigError('PROJECTION_EXECUTION', 'invalid_execution');
  return Object.freeze({ queueName: 'rdm.projection.commits', execution,
    healthPort: integer(env, 'HEALTH_PORT', 9464, 1024, 65535),
    shutdownTimeoutMs: integer(env, 'SHUTDOWN_TIMEOUT_MS', 10000, 1, 60000),
    connectTimeoutMs: integer(env, 'CONNECT_TIMEOUT_MS', 5000, 1, 60000),
    reconnectAttempts: integer(env, 'RECONNECT_ATTEMPTS', 5, 1, 10),
    continuationDelayMs: integer(env, 'PROJECTION_CONTINUATION_DELAY_MS', 10, 1, 60000),
    budget: Object.freeze({ maxCommits: integer(env, 'PROJECTION_MAX_COMMITS', 16, 1, 256),
      maxBytes: integer(env, 'PROJECTION_MAX_BYTES', 1048576, 1, 16777216),
      maxMilliseconds: integer(env, 'PROJECTION_MAX_MILLISECONDS', 100, 1, 60000),
      maxEventsPerCommit: integer(env, 'PROJECTION_MAX_EVENTS_PER_COMMIT', 1000, 1, 10000) }) });
}

export function parseConfig(env: Environment, args: readonly string[]): HostConfig {
  if (args.length) throw new ConfigError('arguments', 'no_arguments_supported');
  checkEnvironment(env);
  const mode = env.PROJECTION_MODE ?? 'external';
  if (mode !== 'reference' && mode !== 'external') throw new ConfigError('PROJECTION_MODE', 'invalid_mode');
  const options = commonOptions(env);
  if (mode === 'external') return Object.freeze({ ...options, mode, external: externalOptions(env) });
  const present = externalKeys.find((key) => env[key] !== undefined);
  if (present) throw new ConfigError(present, 'forbidden_in_reference');
  return Object.freeze({ ...options, mode });
}
