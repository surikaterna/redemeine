import { EventEmitter } from 'node:events';
import type { Collection } from 'mongodb';
import { ProjectionHost } from '../src/host';
import { Observations } from '../src/observability';
import { SessionFence } from '../src/sessionFence';
import { brokerResourceFactory } from '../src/infrastructure/brokerRuntime';
import { builtArtifact } from './fixtures';
import { brokerClients } from './support/brokerClients';
import { deferred, until } from './support/deferred';
import { request } from './support/http';
import { modelCommit } from '../src/reference/scenario';

afterEach(() => { jest.restoreAllMocks(); });

test('native cold-quorum external composition bootstraps, admits early F42 and folds all events before original ACK without prefix', async () => {
  const f = brokerClients(); f.early();
  const artifact = await builtArtifact(); const fence = new SessionFence();
  const connect = brokerResourceFactory(f.mongo.config, artifact, new Observations(undefined, 'external'), f.factories);
  const resource = await connect(new AbortController().signal, fence);
  expect(f.management.queueValue).not.toHaveProperty('policy');
  expect(f.management.queueValue).not.toHaveProperty('operator_policy');
  expect(f.management.queueValue).not.toHaveProperty('effective_policy_definition');
  expect(f.mongo.createIndex).toHaveBeenCalledTimes(2);
  expect(f.connections[0]?.channel.consume).not.toHaveBeenCalled();
  await resource.start(); await until(() => resource.worker.getStatus().activeDeliveries === 0);
  expect(resource.worker.getStatus().accepting).toBe(true);
  const native = f.connections[0]?.channel;
  expect(native?.consume).toHaveBeenCalledWith('rdm.projection.commits', expect.any(Function), { noAck: false, exclusive: false });
  expect(native?.ack).toHaveBeenCalledWith(f.message, false);
  const documents = [...f.data.rows.values()].filter((row) => row.state && typeof row.state === 'object');
  expect(documents.map((row) => row.state)).toEqual([{ count: 5 }, { count: 5 }]);
  expect(f.range.find).toHaveBeenCalledTimes(1);
  expect(f.range.find).toHaveBeenCalledWith({ streamId: f.range.row.streamId, commitSequence: { $gt: 41, $lte: 42 } });
  expect(f.data.trace.indexOf('control:prepared')).toBeLessThan(f.data.trace.indexOf('declare'));
  expect(f.data.trace.indexOf('floor:admit')).toBeLessThan(f.data.trace.indexOf('document'));
  expect(f.data.trace.indexOf('floor:42')).toBeLessThan(f.data.trace.indexOf('ack'));
  await resource.worker.stop(); await resource.close();
});

test('empty queue becomes live-ready200 after consume-ok and topology without waiting for a message', async () => {
  const f = brokerClients(); const artifact = await builtArtifact(); const signals = new EventEmitter();
  const observations = new Observations(undefined, 'external');
  const host = new ProjectionHost({ ...f.mongo.config, healthPort: 0 }, { acquire: async () => ({ close: async () => {} }),
    signals, forceExit: jest.fn(), observations, connect: brokerResourceFactory(f.mongo.config, artifact, observations, f.factories) });
  const done = host.start();
  try {
    await until(() => host.snapshot().liveConsumerReady);
    const ready = await request(host.healthPort, '/ready'); expect(ready.status).toBe(200);
    expect(JSON.parse(ready.text)).toMatchObject({ liveConsumerReady: true, sourceHistoricalCompleteness: 'unknown',
      publisherRecoveryPolicy: 'external_best_effort_on_expiry', referenceOnly: false });
    expect((await request(host.healthPort, '/reference-ready')).status).toBe(503);
    expect(f.connections[0]?.channel.ack).not.toHaveBeenCalled();
  } finally { signals.emit('SIGTERM'); expect(await done).toBe(0); }
});

test('unknown-first redelivery pauses with no source floor/fold/ACK', async () => {
  const f = brokerClients(); f.early(); f.message.fields.redelivered = true;
  const resource = await brokerResourceFactory(f.mongo.config, await builtArtifact(), new Observations(), f.factories)(new AbortController().signal, new SessionFence());
  await resource.start(); await until(() => resource.worker.getStatus().activeDeliveries === 0);
  expect(resource.worker.getStatus().accepting).toBe(false);
  expect(f.data.trace).not.toContain('floor:admit'); expect(f.data.trace).not.toContain('document'); expect(f.data.trace).not.toContain('ack');
  await resource.worker.stop(); await resource.close();
});

test('unclean process restart refuses, graceful quiet restart keeps epoch and deduplicates a known floor', async () => {
  const f = brokerClients(); f.early(); const artifact = await builtArtifact();
  const factory = () => brokerResourceFactory(f.mongo.config, artifact, new Observations(), f.factories);
  const first = await factory()(new AbortController().signal, new SessionFence());
  await first.start(); await until(() => first.worker.getStatus().activeDeliveries === 0);
  const epoch = [...f.data.rows.values()].find((row) => row.version === 1)?.epoch;
  await first.worker.stop(); await first.close();
  f.message.fields.redelivered = true;
  const second = await factory()(new AbortController().signal, new SessionFence());
  await second.start(); await until(() => second.worker.getStatus().activeDeliveries === 0);
  expect([...f.data.rows.values()].find((row) => row.version === 1)?.epoch).toBe(epoch);
  expect(f.data.trace.filter((value) => value === 'document')).toHaveLength(2);
  expect(f.data.trace.filter((value) => value === 'ack')).toHaveLength(2);
  await second.close();
  await expect(factory()(new AbortController().signal, new SessionFence())).rejects.toThrow('restart_reconciliation_required');
});

test.each(['consume_ok', 'topology'])('stop wins late %s with an early original delivery held and no floor/fold/ACK', async (stage) => {
  const f = brokerClients(); f.early(); const pending = deferred<void>(); const controller = new AbortController(); const fence = new SessionFence();
  const resource = await brokerResourceFactory(f.mongo.config, await builtArtifact(), new Observations(), f.factories)(controller.signal, fence);
  const native = f.connections[0]?.channel; if (!native) throw new Error('missing_channel');
  if (stage === 'topology') f.management.gate = pending.promise;
  else {
    const consume = native.consume.getMockImplementation(); if (!consume) throw new Error('missing_consume');
    native.consume.mockImplementation(async (...args) => { const result = await consume(...args); await pending.promise; return result; });
  }
  const starting = resource.start().catch((error: unknown) => error);
  await until(() => native.consume.mock.calls.length === 1);
  expect(resource.worker.getStatus().accepting).toBe(false);
  expect(f.data.trace).not.toContain('floor:admit'); expect(native.ack).not.toHaveBeenCalled();
  controller.abort(); fence.stop(); await resource.worker.stop(); pending.resolve();
  expect(await starting).toBeInstanceOf(Error);
  await resource.close();
  expect(f.data.trace).not.toContain('floor:admit'); expect(f.data.trace).not.toContain('document'); expect(native.ack).not.toHaveBeenCalled();
});

test('failed active topology verification cannot release early delivery', async () => {
  const f = brokerClients(); f.early();
  const resource = await brokerResourceFactory(f.mongo.config, await builtArtifact(), new Observations(), f.factories)(new AbortController().signal, new SessionFence());
  f.management.bindings.push(f.management.binding('another-exchange', '', {}));
  await expect(resource.start()).rejects.toThrow('live_start_unproven');
  expect(resource.worker.getStatus().accepting).toBe(false);
  expect(f.data.trace).not.toContain('floor:admit'); expect(f.data.trace).not.toContain('ack'); expect(f.range.find).not.toHaveBeenCalled();
  await resource.worker.stop(); await resource.close();
});

test('Mongo definition initialization failure prevents consumer registration', async () => {
  const f = brokerClients(); f.mongo.createIndex.mockRejectedValue(new Error('secret-canary'));
  await expect(brokerResourceFactory(f.mongo.config, await builtArtifact(), new Observations(), f.factories)(new AbortController().signal, new SessionFence()))
    .rejects.toThrow('broker_startup_refused');
  expect(f.connections[0]?.channel.consume).not.toHaveBeenCalled();
  expect(f.data.trace).not.toContain('floor:admit'); expect(f.data.trace).not.toContain('document');
});

test.each(['default_exchange', 'expiration', 'priority', 'nonpersistent'])('observed %s publication cannot establish a floor or ACK', async (fault) => {
  const f = brokerClients(); f.early();
  if (fault === 'default_exchange') f.message.fields.exchange = '';
  if (fault === 'expiration') f.message.properties.expiration = '1000';
  if (fault === 'priority') f.message.properties.priority = 0;
  if (fault === 'nonpersistent') f.message.properties.deliveryMode = 1;
  const resource = await brokerResourceFactory(f.mongo.config, await builtArtifact(), new Observations(), f.factories)(new AbortController().signal, new SessionFence());
  await expect(resource.start()).rejects.toThrow();
  expect(resource.worker.getStatus().accepting).toBe(false);
  expect(f.data.trace).not.toContain('floor:admit'); expect(f.data.trace).not.toContain('document'); expect(f.data.trace).not.toContain('ack');
  await resource.worker.stop(); await resource.close();
});

test('resumed publication below durable F pauses without even querying excluded source history', async () => {
  const f = brokerClients(); f.early();
  const resource = await brokerResourceFactory(f.mongo.config, await builtArtifact(), new Observations(), f.factories)(new AbortController().signal, new SessionFence());
  await resource.start(); await until(() => resource.worker.getStatus().activeDeliveries === 0);
  const older = modelCommit(41);
  const message = { ...f.message, fields: { ...f.message.fields, deliveryTag: 2 },
    properties: { ...f.message.properties, messageId: older.commitId },
    content: Buffer.from(JSON.stringify({ ...f.range.row, id: older.commitId, commitSequence: 41 })) };
  f.connections[0]?.channel.handler?.(message);
  await until(() => resource.worker.getStatus().activeDeliveries === 0);
  expect(resource.worker.getStatus().accepting).toBe(false);
  expect(f.range.find).toHaveBeenCalledTimes(1);
  expect(f.data.trace.filter((value) => value === 'document')).toHaveLength(2);
  expect(f.data.trace.filter((value) => value === 'ack')).toHaveLength(1);
  await resource.worker.stop(); await resource.close();
});

test('observed topology loss cannot be washed into a clean restart by later graceful shutdown', async () => {
  jest.useFakeTimers();
  try {
    const f = brokerClients(); const artifact = await builtArtifact();
    const factory = () => brokerResourceFactory(f.mongo.config, artifact, new Observations(), f.factories);
    const resource = await factory()(new AbortController().signal, new SessionFence());
    await resource.start(); f.management.policies = [{ pattern: '.*' }];
    await jest.advanceTimersByTimeAsync(5000);
    await resource.worker.stop(); await resource.close();
    expect([...f.data.rows.values()].find((row) => row.version === 1)?.runState).toBe('active');
    f.management.policies = [];
    await expect(factory()(new AbortController().signal, new SessionFence())).rejects.toThrow('restart_reconciliation_required');
  } finally { jest.useRealTimers(); }
});

test('joined reconnect after first definition save preserves epoch and deduplicates the partial inline fold', async () => {
  const f = brokerClients(); f.early(); const signals = new EventEmitter(); const artifact = await builtArtifact();
  const persist = f.mongo.update.getMockImplementation(); if (!persist) throw new Error('missing_update');
  let disconnected = false;
  f.mongo.update.mockImplementation(async function(this: Collection, ...args) {
    const result = await persist.apply(this, args);
    if (!disconnected && this.collectionName.endsWith('_0_documents')) {
      disconnected = true; f.message.fields.redelivered = true;
      f.connections[0]?.emit('error', new Error('injected_disconnect'));
    }
    return result;
  });
  const config = { ...f.mongo.config, healthPort: 0 }; const observations = new Observations(undefined, 'external');
  const host = new ProjectionHost(config, { signals, observations, random: () => 0, forceExit: jest.fn(),
    acquire: async () => ({ close: async () => {} }), connect: brokerResourceFactory(config, artifact, observations, f.factories) });
  const done = host.start();
  try {
    await until(() => f.connections.length === 2 && f.connections[1]?.channel.ack.mock.calls.length === 1);
    expect(f.connections[0]?.channel.ack).not.toHaveBeenCalled();
    expect(f.data.trace.filter((event) => event === 'document')).toHaveLength(2);
    expect(f.data.trace.filter((event) => event === 'floor:admit')).toHaveLength(1);
    expect(host.snapshot().liveConsumerReady).toBe(true);
  } finally { signals.emit('SIGTERM'); expect(await done).toBe(0); }
});
