import { parseConfig } from '../src/config';
import { ConfigError } from '../src/configValues';
import { externalEnvironment } from './fixtures';

test('empty config defaults external and fails without exposing values', () => {
  expect(() => parseConfig({}, [])).toThrow(ConfigError);
  try { parseConfig({}, []); } catch (error) {
    expect(error).toMatchObject({ variable: 'MONGODB_URI', reason: 'uri_required' });
  }
});

test('reference options are immutable snapshots with bounded defaults and fixed queue', () => {
  const env = { PROJECTION_MODE: 'reference', PROJECTION_MAX_COMMITS: '2' };
  const config = parseConfig(env, []);
  env.PROJECTION_MAX_COMMITS = '99';
  expect(config).toMatchObject({ mode: 'reference', queueName: 'rdm.projection.commits', healthPort: 9464,
    connectTimeoutMs: 5000, shutdownTimeoutMs: 10000, reconnectAttempts: 5, continuationDelayMs: 10,
    budget: { maxCommits: 2, maxBytes: 1048576, maxMilliseconds: 100, maxEventsPerCommit: 1000 } });
  expect(Object.isFrozen(config)).toBe(true);
  expect(Object.isFrozen(config.budget)).toBe(true);
});

test.each(['MONGODB_URI', 'MONGODB_DATABASE', 'MONGODB_COMMITS_COLLECTION', 'RABBITMQ_URI',
  'RABBITMQ_VHOST', 'RABBITMQ_EXCHANGE', 'PROJECTION_PARTITION_ID', 'PROJECTION_TENANT'])('reference rejects %s', (key) => {
  expect(() => parseConfig({ PROJECTION_MODE: 'reference', [key]: 'secret-canary' }, [])).toThrow('invalid_configuration');
});

test.each(['PROJECTION_QUEUE', 'PROJECTION_QUEUE_NAME', 'PROJECTION_REGISTRY_DIGEST', 'PROJECTION_START_JSON',
  'PROJECTION_TRUSTED', 'PROJECTION_STATE_DIR', 'PROJECTION_MODULE', 'MONGODB_PASSWORD', 'RABBITMQ_PASSWORD'])('rejects override %s', (key) => {
  expect(() => parseConfig({ PROJECTION_MODE: 'reference', [key]: 'secret-canary' }, [])).toThrow(ConfigError);
});

test.each(['--help', '--reference', 'secret-canary'])('rejects argument %s', (arg) => {
  expect(() => parseConfig({ PROJECTION_MODE: 'reference' }, [arg])).toThrow(ConfigError);
});

test.each(['', 'REFERENCE', 'trusted', 'production'])('rejects invalid mode %s', (mode) => {
  expect(() => parseConfig({ PROJECTION_MODE: mode }, [])).toThrow(ConfigError);
});

test.each([
  ['HEALTH_PORT', '1023'], ['HEALTH_PORT', '65536'], ['SHUTDOWN_TIMEOUT_MS', '0'], ['SHUTDOWN_TIMEOUT_MS', '60001'],
  ['CONNECT_TIMEOUT_MS', '-1'], ['CONNECT_TIMEOUT_MS', '60001'], ['RECONNECT_ATTEMPTS', '0'], ['RECONNECT_ATTEMPTS', '11'],
  ['PROJECTION_MAX_COMMITS', '257'], ['PROJECTION_MAX_BYTES', '16777217'], ['PROJECTION_MAX_MILLISECONDS', '60001'],
  ['PROJECTION_MAX_EVENTS_PER_COMMIT', '10001'], ['PROJECTION_CONTINUATION_DELAY_MS', '60001'],
  ['HEALTH_PORT', '1e4'], ['HEALTH_PORT', 'Infinity'], ['HEALTH_PORT', '9464.0'], ['HEALTH_PORT', ' 9464']
])('rejects bounded scalar %s=%s', (key, value) => {
  expect(() => parseConfig({ PROJECTION_MODE: 'reference', [key]: value }, [])).toThrow(ConfigError);
});

test('external config validates and snapshots but cannot grant evidence', () => {
  const config = parseConfig(externalEnvironment, []);
  expect(config.mode).toBe('external');
  if (config.mode !== 'external') throw new Error('expected external');
  expect(Object.isFrozen(config.external)).toBe(true);
  expect(config.external).toMatchObject({ database: 'model', vhost: '/', collection: 'commits' });
});

test.each(['RABBITMQ_MANAGEMENT_URL', 'RABBITMQ_MANAGEMENT_USERNAME', 'RABBITMQ_MANAGEMENT_PASSWORD'])('external broker mode requires %s and reference rejects it', (key) => {
  expect(() => parseConfig({ ...externalEnvironment, [key]: undefined }, [])).toThrow(ConfigError);
  expect(() => parseConfig({ PROJECTION_MODE: 'reference', [key]: 'secret-canary' }, [])).toThrow(ConfigError);
});

test.each([
  { RABBITMQ_MANAGEMENT_URL: 'http://remote.example' },
  { RABBITMQ_MANAGEMENT_URL: 'https://user:secret-canary@remote.example' },
  { RABBITMQ_MANAGEMENT_URL: 'https://remote.example/path' },
  { RABBITMQ_MANAGEMENT_URL: 'https://remote.example/?token=secret-canary' },
  { RABBITMQ_MANAGEMENT_USERNAME: 'user:other' },
  { RABBITMQ_MANAGEMENT_PASSWORD: 'secret\ncanary' },
  { MONGODB_DATABASE: 'database:invalid' },
  { MONGODB_DATABASE: 'x'.repeat(64) }
])('broker configuration rejects unsafe endpoint/credential/database shape', (override) => {
  expect(() => parseConfig({ ...externalEnvironment, ...override }, [])).toThrow('invalid_configuration');
});

test.each([
  { MONGODB_URI: 'http://secret-canary@invalid.example' }, { RABBITMQ_URI: 'https://invalid.example' },
  { RABBITMQ_VHOST: 'wrong' }, { RABBITMQ_URI: 'amqp://invalid.example/%ZZ' },
  { MONGODB_DATABASE: '' }, { MONGODB_COMMITS_COLLECTION: 'x'.repeat(129) }, { PROJECTION_TENANT: 'bad/name' }
])('rejects invalid external configuration without leaking it', (override) => {
  expect(() => parseConfig({ ...externalEnvironment, ...override }, [])).toThrow('invalid_configuration');
});
