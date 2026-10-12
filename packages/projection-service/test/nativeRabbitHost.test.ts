import { EventEmitter } from 'node:events';
import type { Collection } from 'mongodb';
import { ProjectionHost } from '../src/host';
import { brokerResourceFactory } from '../src/infrastructure/brokerRuntime';
import { Observations } from '../src/observability';
import { builtArtifact } from './fixtures';
import { deferred, until } from './support/deferred';
import { nativeBrokerClients } from './support/nativeBrokerClients';

afterEach(() => { jest.restoreAllMocks(); });

async function fixture(suspendClose = false) {
  const clients = nativeBrokerClients(suspendClose); const artifact = await builtArtifact();
  const signals = new EventEmitter(); const closeOwner = jest.fn(async () => {}); const forceExit = jest.fn();
  const config = { ...clients.mongo.config, healthPort: 0, shutdownTimeoutMs: 100 };
  const observations = new Observations(undefined, 'external');
  const host = new ProjectionHost(config, { signals, observations, forceExit, random: () => 0,
    acquire: async () => ({ close: closeOwner }),
    connect: brokerResourceFactory(config, artifact, observations, clients.factories) });
  return { ...clients, host, signals, closeOwner, forceExit };
}

function disconnectAfterFirstSave(f: Awaited<ReturnType<typeof fixture>>): void {
  const persist = f.mongo.update.getMockImplementation(); if (!persist) throw new Error('missing_update');
  let disconnected = false;
  f.mongo.update.mockImplementation(async function(this: Collection, ...args) {
    const result = await persist.apply(this, args);
    if (!disconnected && this.collectionName.endsWith('_0_documents')) {
      disconnected = true; f.message.fields.redelivered = true; f.natives[0]?.closeConnection();
    }
    return result;
  });
}

test.each(['idle', 'partial_definition'])('actual native %s disconnect joins old cleanup then reconnects in the same epoch and SIGTERM exits0', async (point) => {
  const f = await fixture(); const oldMongoClose = deferred<void>();
  if (point === 'partial_definition') disconnectAfterFirstSave(f);
  f.mongo.close.mockImplementationOnce(() => oldMongoClose.promise);
  const done = f.host.start();
  try {
    await until(() => f.host.snapshot().liveConsumerReady);
    const first = f.natives[0]; if (!first) throw new Error('missing_native');
    const epoch = [...f.data.rows.values()].find((row) => row.version === 1)?.epoch;
    first.deliver(f.message);
    if (point === 'idle') {
      await until(() => first.frames.some((frame) => frame.method === 'BasicAck'));
      first.closeConnection();
    }
    await until(() => f.mongo.close.mock.calls.length === 1);
    expect(first.state()).toEqual({ channelClosed: true, connectionClosed: true, network: false });
    expect(f.natives).toHaveLength(1); expect(f.closeOwner).not.toHaveBeenCalled();
    oldMongoClose.resolve();
    await until(() => f.natives.length === 2 && f.host.snapshot().liveConsumerReady);
    const second = f.natives[1]; if (!second) throw new Error('missing_reconnected_native');
    f.message.fields.redelivered = true; second.deliver(f.message);
    await until(() => second.frames.some((frame) => frame.method === 'BasicAck'));
    expect([...f.data.rows.values()].find((row) => row.version === 1)?.epoch).toBe(epoch);
    expect(f.data.trace.filter((event) => event === 'document')).toHaveLength(2);
    expect(f.data.trace.filter((event) => event === 'floor:admit')).toHaveLength(1);
    expect(first.frames.some((frame) => frame.method === 'BasicAck')).toBe(point === 'idle');
    expect(first.frames.some((frame) => frame.method === 'ChannelClose' || frame.method === 'ConnectionClose')).toBe(false);
  } finally {
    oldMongoClose.resolve(); f.signals.emit('SIGTERM'); expect(await done).toBe(0);
  }
  expect(f.closeOwner).toHaveBeenCalledTimes(1); expect(f.forceExit).not.toHaveBeenCalled();
  for (const native of f.natives) expect(native.model.listenerCount('close')).toBe(1);
});

test('native error-only with unconfirmed close RPC stays unready, cannot reconnect/release, and reaches deadline124', async () => {
  const f = await fixture(true); const done = f.host.start();
  let first: (typeof f.natives)[number] | undefined;
  try {
    await until(() => f.host.snapshot().liveConsumerReady);
    first = f.natives[0]; if (!first) throw new Error('missing_native');
    first.model.emit('error', new Error('simulated_error_without_native_close'));
    f.host.snapshot();
    await until(() => !!first?.frames.some((frame) => frame.method === 'ChannelClose'));
    expect(first.state()).toEqual({ channelClosed: false, connectionClosed: false, network: false });
    expect(f.host.snapshot().liveConsumerReady).toBe(false); expect(f.natives).toHaveLength(1);
    f.signals.emit('SIGTERM');
    expect(await done).toBe(124); expect(f.forceExit).toHaveBeenCalledWith(124);
    expect(f.closeOwner).not.toHaveBeenCalled(); expect(f.natives).toHaveLength(1);
  } finally { first?.closeConnection(); }
  await Promise.resolve();
  expect(f.closeOwner).not.toHaveBeenCalled(); expect(f.natives).toHaveLength(1);
});
