import { BrokerTopology, bindingArguments, queueArguments } from '../src/infrastructure/brokerTopology';
import { externalConfig } from './support/mongoClient';
import { ManagementFixture } from './support/brokerManagement';
import { object, list } from '../src/infrastructure/brokerSchema';
import { consumerFacts } from '../src/infrastructure/consumerFacts';

const identity = { connectionLabel: 'owned-connection', channelNumber: 2, peerHost: '127.0.0.1', peerPort: 12345,
  host: '127.0.0.1', port: 5672, user: 'user' };

function fixture() {
  const config = externalConfig();
  const management = new ManagementFixture(config);
  management.declare('nonce'); management.bind();
  return { config, management, topology: new BrokerTopology(config, management) };
}

function rawQueue(management: ManagementFixture): void {
  const get = management.get.bind(management);
  jest.spyOn(management, 'get').mockImplementation(async (segments) => {
    if (segments[0] === 'queues' && segments.length === 3) return management.queueValue;
    return get(segments);
  });
}

afterEach(() => { jest.restoreAllMocks(); });

test('checks all queue bindings including default broker binding, incoming exchange routes and both policy scopes', async () => {
  const f = fixture();
  await f.topology.inspect('nonce');
  expect(f.management.requests).toContainEqual(['queues', '/', 'rdm.projection.commits', 'bindings']);
  expect(f.management.requests).toContainEqual(['exchanges', '/', 'commits', 'bindings', 'destination']);
  expect(f.management.requests).toContainEqual(['policies', '/']);
  expect(f.management.requests).toContainEqual(['operator-policies', '/']);
});

test.each([null, ''])('accepts explicit empty queue policies %p', async (value) => {
  const f = fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
  f.management.queueValue.policy = value; f.management.queueValue.operator_policy = value;
  await expect(f.topology.inspect('nonce')).resolves.toBeUndefined();
});

describe.each(['policy', 'operator_policy'] as const)('%s queue policy', (field) => {
  test.each(['named', ' ', false, 0, [], {}, undefined])('rejects present non-empty or malformed value %p', async (value) => {
    const f = fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
    f.management.queueValue[field] = value;
    rawQueue(f.management);
    await expect(f.topology.inspect('nonce')).rejects.toThrow('broker_policy_unproven');
  });
});

test.each([{ 'delivery-limit': 20 }, { 'message-ttl': 1 }, null, [], undefined])('omitted policies do not excuse effective policy %p', async (value) => {
  const f = fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
  f.management.queueValue.effective_policy_definition = value;
  rawQueue(f.management);
  await expect(f.topology.inspect('nonce')).rejects.toThrow('broker_queue_effective_policy_invalid');
});

test('cold quorum omission and populated empty effective policy are both admitted', async () => {
  const f = fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
  expect(f.management.queueValue).not.toHaveProperty('effective_policy_definition');
  await expect(f.topology.inspect('nonce')).resolves.toBeUndefined();
  f.management.queueValue.effective_policy_definition = {};
  await expect(f.topology.inspect('nonce')).resolves.toBeUndefined();
});

test.each(['policies', 'operators'] as const)('cold omission never excuses nonempty global %s', async (field) => {
  const f = fixture(); f.management[field].push({ pattern: '.*', definition: { 'message-ttl': 1 } });
  await expect(f.topology.inspect('nonce')).rejects.toThrow('broker_policy_unproven');
});

test.each(['omitted', 'undefined', 'null', 'object', 'over_capacity'])('consumer_details %s never becomes an empty list', async (fault) => {
  const f = fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
  const queue = f.management.queueValue;
  if (fault === 'omitted') delete queue.consumer_details;
  if (fault === 'undefined') queue.consumer_details = undefined;
  if (fault === 'null') queue.consumer_details = null;
  if (fault === 'object') queue.consumer_details = {};
  if (fault === 'over_capacity') queue.consumer_details = Array.from({ length: 17 }, () => ({}));
  rawQueue(f.management);
  await expect(f.topology.inspect('nonce')).rejects.toThrow('broker_queue_consumer_details_invalid');
  await expect(f.topology.inspect('nonce', { tag: 'actual-tag', identity })).rejects.toThrow('broker_queue_consumer_details_invalid');
  await expect(f.topology.inspect('nonce', { tag: 'actual-tag', identity }, true)).rejects.toThrow('broker_queue_consumer_details_invalid');
});

test('empty details cannot prove an active consumer and another consumer cannot prove an idle queue', async () => {
  const f = fixture();
  await expect(f.topology.inspect('nonce', { tag: 'actual-tag', identity })).rejects.toThrow('broker_consumer_conflict');
  f.management.consume('other-tag', identity);
  await expect(f.topology.inspect('nonce')).rejects.toThrow('broker_consumer_conflict');
});

test('invalid queue response and malformed arguments retain exact safe field codes', async () => {
  const f = fixture(); const queue = f.management.queueValue; if (!queue) throw new Error('missing_queue');
  f.management.queueValue = null;
  await expect(f.topology.inspect('nonce')).rejects.toThrow('broker_queue_response_invalid');
  f.management.queueValue = queue; queue.arguments = [];
  await expect(f.topology.inspect('nonce')).rejects.toThrow('broker_queue_arguments_invalid');
});

test.each(['other_exchange', 'stream_filter', 'any_match', 'tenant', 'missing_default', 'inbound', 'policy', 'operator'])('%s invalidates binding scope', async (fault) => {
  const f = fixture();
  if (fault === 'other_exchange') f.management.bindings.push(f.management.binding('other', '', bindingArguments(f.config)));
  if (fault === 'stream_filter') f.management.bindings[1] = f.management.binding('commits', '', { ...bindingArguments(f.config), streamId: 'one' });
  if (fault === 'any_match') f.management.bindings[1] = f.management.binding('commits', '', { ...bindingArguments(f.config), 'x-match': 'any' });
  if (fault === 'tenant') f.management.bindings[1] = f.management.binding('commits', '', { ...bindingArguments(f.config), tenant: 'other' });
  if (fault === 'missing_default') f.management.bindings.shift();
  if (fault === 'inbound') f.management.inbound.push({ source: 'other' });
  if (fault === 'policy') f.management.policies.push({ pattern: '.*', definition: { 'message-ttl': 1 } });
  if (fault === 'operator') f.management.operators.push({ pattern: '.*', definition: { 'delivery-limit': 20 } });
  await expect(f.topology.inspect('nonce')).rejects.toThrow();
});

test.each(['x-message-ttl', 'x-expires', 'x-max-length', 'x-max-length-bytes', 'x-dead-letter-exchange', 'x-max-priority'])('rejects forbidden queue argument %s', async (key) => {
  const f = fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
  f.management.queueValue.arguments = { ...queueArguments('nonce'), [key]: 1 };
  await expect(f.topology.inspect('nonce')).rejects.toThrow();
});

test.each(['nonce', 'type', 'durable', 'exclusive', 'auto_delete'])('rejects queue %s mutation', async (field) => {
  const f = fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
  if (field === 'nonce') f.management.queueValue.arguments = queueArguments('other');
  else f.management.queueValue[field] = field === 'type' ? 'classic' : field !== 'durable';
  await expect(f.topology.inspect('nonce')).rejects.toThrow();
});

test('empty queue readiness uses owned active consumer identity, not message arrival or client-provided label alone', async () => {
  const f = fixture(); f.management.consume('actual-tag', identity);
  await expect(f.topology.inspect('nonce', { tag: 'actual-tag', identity })).resolves.toBeUndefined();
  await expect(f.topology.inspect('nonce', { tag: 'forged-tag', identity })).rejects.toThrow();
  f.management.connection.peer_port = 999;
  await expect(f.topology.inspect('nonce', { tag: 'actual-tag', identity })).rejects.toThrow();
});

test.each(['absent', 0, 1])('initial empty details with count %p are pending, not admission or ongoing requalification', async (count) => {
  const f = fixture(); const selected = { tag: 'actual-tag', identity };
  const queue = object(f.management.queueValue);
  if (count === 'absent') delete queue.consumers; else queue.consumers = count;
  await expect(f.topology.inspect('nonce', selected, true)).rejects.toThrow('broker_consumer_count_pending');
  await expect(f.topology.inspect('nonce', selected)).rejects.toThrow('broker_consumer_conflict');
  const facts = consumerFacts(queue, []);
  if (count === 'absent') {
    expect(facts.startupQueueConsumerCountShape).toBe('absent'); expect(facts).not.toHaveProperty('startupQueueConsumerCount');
  } else expect(facts.startupQueueConsumerCount).toBe(count);
});

test.each([undefined, null, false, '0', -1, 1.5, NaN, Infinity, {}, []])('own malformed count %p never yields pending or active admission', async (count) => {
  const f = fixture(); object(f.management.queueValue).consumers = count;
  rawQueue(f.management);
  await expect(f.topology.inspect('nonce', { tag: 'actual-tag', identity }, true)).rejects.toThrow('broker_consumer_count_inconsistent');
  f.management.consume('actual-tag', identity); object(f.management.queueValue).consumers = count;
  await expect(f.topology.inspect('nonce', { tag: 'actual-tag', identity }, true)).rejects.toThrow('broker_consumer_count_inconsistent');
});

test('two consumer details or a queue count above one always conflict, including initial inspection', async () => {
  const f = fixture(); f.management.consume('actual-tag', identity); const queue = object(f.management.queueValue);
  const details = list(queue.consumer_details); queue.consumer_details = [...details, ...details];
  await expect(f.topology.inspect('nonce', { tag: 'actual-tag', identity }, true)).rejects.toThrow('broker_consumer_conflict');
  queue.consumer_details = details; queue.consumers = 2;
  await expect(f.topology.inspect('nonce', { tag: 'actual-tag', identity }, true)).rejects.toThrow('broker_consumer_conflict');
});

test.each([
  ['consumer_tag', 'forged', 'broker_consumer_tag_mismatch'], ['active', false, 'broker_consumer_active_mismatch'],
  ['ack_required', false, 'broker_consumer_ack_mismatch'], ['exclusive', true, 'broker_consumer_exclusive_mismatch'],
  ['prefetch_count', 2, 'broker_consumer_prefetch_mismatch'], ['arguments', { secret: true }, 'broker_consumer_arguments_mismatch'],
  ['queue', { name: 'other', vhost: '/' }, 'broker_consumer_queue_mismatch'],
  ['channel_details', { number: 9, connection_name: 'secret' }, 'broker_consumer_channel_mismatch']
])('consumer tuple %s mismatch retains a closed refusal', async (field, value, code) => {
  const f = fixture(); f.management.consume('actual-tag', identity);
  if (typeof field !== 'string' || typeof code !== 'string') throw new Error('invalid_case');
  object(list(object(f.management.queueValue).consumer_details)[0])[field] = value;
  await expect(f.topology.inspect('nonce', { tag: 'actual-tag', identity }, true)).rejects.toThrow(code);
});

test('consumer facts are bounded and never expose tag, channel name, UUID, credentials or arbitrary values', () => {
  const facts = consumerFacts({ consumers: 'amqp://secret' }, [{ consumer_tag: 'private-tag', active: true, channel_details: { connection_name: 'secret' } }], 'expected');
  expect(facts).toEqual({ startupConsumerDetailsCount: 1, startupQueueConsumerCountShape: 'invalid', startupConsumerActive: true, startupConsumerTagMatches: false });
  expect(JSON.stringify(facts)).not.toMatch(/amqp|private-tag|secret/);
  expect(consumerFacts({}, [])).toEqual({ startupConsumerDetailsCount: 0, startupQueueConsumerCountShape: 'absent' });
});
