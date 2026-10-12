import { MongoServerError } from 'mongodb';
import { startupCode, startupHttpRoute } from '../src/startupDiagnostics';
import { Observations } from '../src/observability';
import { BrokerRefusal } from '../src/infrastructure/brokerSchema';
import { InfrastructureError } from '../src/infrastructure/failure';
import { TransientConnectionError } from '../src/reconnect';
import { sourceIndexFacts, startupFacts, assertPolicyRefusal } from '../integration/startupEvidence';
import { sanitizedLogs } from '../integration/receipts';
import { brokerResourceFactory } from '../src/infrastructure/brokerRuntime';
import { brokerClients } from './support/brokerClients';
import { SessionFence } from '../src/sessionFence';
import { builtArtifact } from './fixtures';

afterEach(() => { jest.restoreAllMocks(); });

test.each([
  [new BrokerRefusal('broker_policy_unproven'), 'broker_policy_unproven'],
  [new BrokerRefusal('broker_queue_response_invalid'), 'broker_queue_response_invalid'],
  [new BrokerRefusal('broker_queue_arguments_invalid'), 'broker_queue_arguments_invalid'],
  [new BrokerRefusal('broker_queue_effective_policy_invalid'), 'broker_queue_effective_policy_invalid'],
  [new BrokerRefusal('broker_queue_consumer_details_invalid'), 'broker_queue_consumer_details_invalid'],
  [new BrokerRefusal('secret-canary'), 'broker_refused'],
  [new InfrastructureError('rabbit_prerequisite_failed'), 'rabbit_prerequisite_failed'],
  [new TransientConnectionError(), 'connection_transient'],
  [new MongoServerError({ message: 'secret-canary', code: 18 }), 'mongo_authentication_failed'],
  [new MongoServerError({ message: 'secret-canary', code: 11000 }), 'mongo_duplicate_key'],
  [new Error('Exactly one usable Tapeworm streamId/commitSequence index is required.'), 'mongo_range_index_unready'],
  [new Error('live_start_unproven'), 'live_start_unproven'],
  [new Error('mongodb://secret-canary'), 'unknown_error']
])('startup classifier returns only a closed safe code: %s', (error, expected) => {
  expect(startupCode(error)).toBe(expected);
});

test('stage/code and safeHTTPfacts are exposed without changing readiness or echoing native error data', () => {
  const observations = new Observations(undefined, 'external');
  observations.startup('binding', new BrokerRefusal('broker_management_refused'));
  observations.http('queue', 403, true);
  const snapshot = observations.snapshot(false);
  expect(snapshot).toMatchObject({ startupStage: 'binding', startupCode: 'broker_management_refused',
    startupHttpRoute: 'queue', startupHttpStatus: 403, startupHttpJson: true, liveConsumerReady: false });
  expect(sanitizedLogs(JSON.stringify(snapshot))).toContain('broker_management_refused');
  observations.startup('rabbit_identity', new Error('secret-canary amqp://password'));
  expect(JSON.stringify(observations.snapshot(false))).not.toMatch(/secret-canary|password|amqp/);
});

test.each([
  {}, { startupStage: 'source_reader', startupCode: 'broker_store_unready' },
  { startupStage: 'binding', startupCode: 'broker_schema_invalid' },
  { startupStage: 'binding', startupCode: 'secret-canary' }
])('generic/unrelated startuprefusal cannot pass policynegative: %j', (body) => {
  expect(() => assertPolicyRefusal(body)).toThrow('policy_refusal_cause_unproven');
  expect(JSON.stringify(startupFacts(body))).not.toContain('secret-canary');
});

test('explicit policy-refusal code at binding stage is required', () => {
  expect(() => assertPolicyRefusal({ startupStage: 'binding', startupCode: 'broker_policy_unproven' })).not.toThrow();
  expect(startupHttpRoute(['queues', 'secret-canary', 'other'])).toBe('queue');
  expect(startupHttpRoute(['queues', '/', 'queue', 'bindings'])).toBe('bindings');
});

test.each(['broker_queue_response_invalid', 'broker_queue_arguments_invalid', 'broker_queue_effective_policy_invalid',
  'broker_queue_consumer_details_invalid'])('queue field diagnostic %s survives health/log/receipt without granting policy-negative success', (code) => {
  const observations = new Observations(undefined, 'external');
  observations.startup('binding', new BrokerRefusal(code)); observations.http('queue', 200, true);
  const body = observations.snapshot(false);
  expect(startupFacts(body)).toMatchObject({ stage: 'binding', code, httpRoute: 'queue', httpStatus: 200, httpJson: true });
  expect(sanitizedLogs(JSON.stringify(body))).toContain(code);
  expect(() => assertPolicyRefusal(body)).toThrow('policy_refusal_cause_unproven');
  expect(body.liveConsumerReady).toBe(false);
});

test('source index catalog facts retain exactrange descriptor but omit unknownname/key/partialpredicate/collation secrets', () => {
  expect(sourceIndexFacts({ name: 'streamId_1_commitSequence_1', key: { streamId: 1, commitSequence: 1 }, unique: true }))
    .toMatchObject({ name: 'streamId_1_commitSequence_1', key: { streamId: 1, commitSequence: 1 }, unique: true,
      sparse: false, partial: false, ttl: false, collation: 'absent' });
  const facts = sourceIndexFacts({ name: 'secret-canary', key: { 'secret-canary': 1 }, unique: true,
    partialFilterExpression: { password: 'secret-canary' }, collation: { locale: 'secret-canary' } });
  expect(facts).toMatchObject({ keyShape: 'unsupported', partial: true, collation: 'non_simple' });
  expect(JSON.stringify(facts)).not.toMatch(/secret-canary|password/);
});

test('policy source-stage refusal is positively identified before control/provisioning without masking cleanup', async () => {
  const f = brokerClients(); f.management.policies = [{ pattern: '.*' }]; const observations = new Observations(undefined, 'external');
  await expect(brokerResourceFactory(f.mongo.config, await builtArtifact(), observations, f.factories)
    (new AbortController().signal, new SessionFence())).rejects.toThrow('broker_policy_unproven');
  expect(observations.snapshot(false)).toMatchObject({ startupStage: 'binding', startupCode: 'broker_policy_unproven' });
  expect(f.data.rows.size).toBe(0); expect(f.data.trace).not.toContain('declare');
  expect(f.connections[0]?.close).toHaveBeenCalled();
});

test('actual range-index initialization failure retains source_reader code despite facade wrapping', async () => {
  const f = brokerClients(); f.mongo.indexRows.mockResolvedValue([]); const observations = new Observations(undefined, 'external');
  await expect(brokerResourceFactory(f.mongo.config, await builtArtifact(), observations, f.factories)
    (new AbortController().signal, new SessionFence())).rejects.toThrow('broker_store_unready');
  expect(observations.snapshot(false)).toMatchObject({ startupStage: 'source_reader', startupCode: 'mongo_range_index_unready' });
  expect(f.connections).toHaveLength(0); expect(f.data.rows.size).toBe(0);
});

test('definition-store initialization failure identifies precise phase but not arbitrary vendor text', async () => {
  const f = brokerClients(); f.mongo.createIndex.mockRejectedValue(new Error('secret-canary')); const observations = new Observations(undefined, 'external');
  await expect(brokerResourceFactory(f.mongo.config, await builtArtifact(), observations, f.factories)
    (new AbortController().signal, new SessionFence())).rejects.toThrow('broker_startup_refused');
  expect(observations.snapshot(false)).toMatchObject({ startupStage: 'store_initialization', startupCode: 'unknown_error' });
  expect(JSON.stringify(observations.snapshot(false))).not.toContain('secret-canary');
  expect(f.connections[0]?.channel.consume).not.toHaveBeenCalled();
});

test('consumer facts and pending/activation codes remain bounded, value-free and cannot pass policy negative', () => {
  const observations = new Observations(undefined, 'external');
  observations.consumer({ startupConsumerDetailsCount: 0, startupQueueConsumerCountShape: 'integer', startupQueueConsumerCount: 0 });
  observations.startup('consumer_start', new BrokerRefusal('broker_consumer_activation_deadline'));
  const body = observations.snapshot(false);
  expect(startupFacts(body)).toMatchObject({ stage: 'consumer_start', code: 'broker_consumer_activation_deadline',
    startupConsumerDetailsCount: 0, startupQueueConsumerCountShape: 'integer', startupQueueConsumerCount: 0 });
  expect(sanitizedLogs(JSON.stringify(body))).toContain('startupQueueConsumerCount');
  expect(() => assertPolicyRefusal(body)).toThrow('policy_refusal_cause_unproven'); expect(body.liveConsumerReady).toBe(false);
  const facts = startupFacts({ startupConsumerDetailsCount: 99, startupQueueConsumerCount: -1,
    startupQueueConsumerCountShape: 'secret', startupConsumerActive: 'secret', startupConsumerTagMatches: 'secret' });
  expect(JSON.stringify(facts)).not.toContain('secret'); expect(facts).not.toHaveProperty('startupConsumerDetailsCount');
  expect(sanitizedLogs(JSON.stringify({ startupConsumerDetailsCount: 99, startupQueueConsumerCount: -1,
    startupQueueConsumerCountShape: 'broker_policy_unproven', startupConsumerActive: 'secret' }))).not.toMatch(/startupConsumer|startupQueueConsumer/);
});
