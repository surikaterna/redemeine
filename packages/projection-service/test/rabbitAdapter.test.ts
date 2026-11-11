import type { LiveRabbitDelivery } from '@redemeine/projection-transport';
import { connect } from 'amqplib';
import { openRabbitPrerequisites } from '../src/infrastructure/rabbit';
import { liveQueueName } from '../src/infrastructure/rabbitChannel';
import { deferred, until } from './support/deferred';
import { externalConfig } from './support/mongoClient';
import { FakeRabbitConnection, rabbitClientFixture, rawMessage } from './support/rabbitClient';

jest.mock('amqplib', () => ({ connect: jest.fn() }));
afterEach(() => { jest.restoreAllMocks(); });

test('default connector delegates to the actual amqplib API with bounded socket options', async () => {
  jest.mocked(connect).mockRejectedValue(new Error('secret-canary'));
  const config = externalConfig();
  await expect(openRabbitPrerequisites(config, new AbortController().signal)).rejects.toThrow('rabbit_prerequisite_failed');
  expect(connect).toHaveBeenCalledWith(config.external.rabbitmqUri, { timeout: 5000 });
});

test('amqplib client shape, existing queue only; existence is NOT durability/binding/no-drop proof', async () => {
  const f = rabbitClientFixture(); const config = externalConfig();
  const rabbit = await openRabbitPrerequisites(config, new AbortController().signal, f.factory);
  expect(f.factory).toHaveBeenCalledWith(config.external.rabbitmqUri, { timeout: 5000 });
  expect(f.connection.createChannel).toHaveBeenCalledTimes(1);
  expect(f.native.checkQueue).toHaveBeenCalledWith(liveQueueName);
  expect(rabbit.queueFacts).toEqual({ queue: liveQueueName, existence: 'observed', expectedDurable: true,
    observedDurability: 'unknown', binding: 'unknown', effectiveNoDrop: 'unknown', qualification: 'unproven' });
  expect(f.native.consume).not.toHaveBeenCalled();
  await rabbit.close(); await rabbit.close();
  expect(f.native.close).toHaveBeenCalledTimes(1); expect(f.connection.close).toHaveBeenCalledTimes(1);
});

test('exact prefetch/exclusive manual delivery fidelity and original-message ACK once', async () => {
  const f = rabbitClientFixture();
  const { channel, close } = await openRabbitPrerequisites(externalConfig(), new AbortController().signal, f.factory);
  let delivery: LiveRabbitDelivery | null = null;
  await channel.prefetch(1);
  await channel.consume(liveQueueName, (received) => { delivery = received; }, { exclusive: true, noAck: false });
  expect(f.native.prefetch).toHaveBeenCalledWith(1, false);
  expect(f.native.consume).toHaveBeenCalledWith(liveQueueName, expect.any(Function), { exclusive: true, noAck: false });
  const original = rawMessage(); f.native.handler?.(original);
  expect(delivery).toEqual({ content: original.content, fields: { deliveryTag: 1, redelivered: true },
    properties: { messageId: original.properties.messageId, headers: original.properties.headers } });
  if (!delivery) throw new Error('missing_delivery');
  const received: LiveRabbitDelivery = delivery;
  expect(received.content).not.toBe(original.content);
  expect(() => channel.ack({ ...received })).toThrow('rabbit_ack_refused');
  channel.ack(received);
  expect(f.native.ack).toHaveBeenCalledWith(original, false);
  expect(f.native.ack.mock.calls[0]?.[0]).toBe(original);
  expect(() => channel.ack(received)).toThrow('rabbit_ack_refused');
  expect(f.native.ack).toHaveBeenCalledTimes(1);
  await close();
});

test.each(['cancel', 'channel_close', 'channel_error', 'connection_close', 'connection_error', 'overlap'])('%s invalidates outstanding ACK without raw error forwarding', async (fault) => {
  const f = rabbitClientFixture();
  const rabbit = await openRabbitPrerequisites(externalConfig(), new AbortController().signal, f.factory);
  const deliveries: LiveRabbitDelivery[] = [];
  const listener = jest.fn(); rabbit.channel.on('error', listener);
  await rabbit.channel.prefetch(1);
  await rabbit.channel.consume(liveQueueName, (message) => { if (message) deliveries.push(message); }, { exclusive: true, noAck: false });
  f.native.handler?.(rawMessage());
  if (fault === 'cancel') await rabbit.channel.cancel('actual-consumer-tag');
  if (fault === 'overlap') f.native.handler?.(rawMessage(2));
  if (fault.startsWith('channel_')) f.native.emit(fault === 'channel_close' ? 'close' : 'error', new Error('secret-canary'));
  if (fault.startsWith('connection_')) f.connection.emit(fault === 'connection_close' ? 'close' : 'error', new Error('secret-canary'));
  const message = deliveries[0]; if (!message) throw new Error('missing_delivery');
  expect(() => rabbit.channel.ack(message)).toThrow('rabbit_ack_refused');
  expect(f.native.ack).not.toHaveBeenCalled();
  expect(JSON.stringify(listener.mock.calls)).not.toContain('secret-canary');
  rabbit.channel.removeListener('error', listener);
  expect(rabbit.channel.listeners('error')).not.toContain(listener);
  await rabbit.close();
});

test('wrong queue and prefetch cannot alter the fixed subscription', async () => {
  const f = rabbitClientFixture(); const rabbit = await openRabbitPrerequisites(externalConfig(), new AbortController().signal, f.factory);
  await expect(rabbit.channel.checkQueue('other')).rejects.toThrow('rabbit_prerequisite_failed');
  await expect(rabbit.channel.prefetch(2)).rejects.toThrow('rabbit_prerequisite_failed');
  await expect(rabbit.channel.consume(liveQueueName, () => {}, { noAck: false, exclusive: true })).rejects.toThrow();
  expect(f.native.consume).not.toHaveBeenCalled(); await rabbit.close();
});

test('unknown message ID stays absent, broker cancellation stays null, no synthetic identity', async () => {
  const f = rabbitClientFixture(); const rabbit = await openRabbitPrerequisites(externalConfig(), new AbortController().signal, f.factory);
  const handler = jest.fn(); await rabbit.channel.prefetch(1);
  await rabbit.channel.consume(liveQueueName, handler, { noAck: false, exclusive: true });
  const message = rawMessage(); message.properties.messageId = undefined; message.properties.headers = undefined;
  f.native.handler?.(message);
  expect(handler.mock.calls[0]?.[0].properties).toEqual({});
  f.native.handler?.(null); expect(handler).toHaveBeenLastCalledWith(null);
  await rabbit.close();
});

test.each(['connect', 'channel', 'queue'])('%s failure closes owned resources, does not provision or consume', async (fault) => {
  const f = rabbitClientFixture();
  if (fault === 'channel') f.connection.createChannel.mockRejectedValue(new Error('secret-canary'));
  if (fault === 'queue') f.native.checkQueue.mockRejectedValue(new Error('secret-canary'));
  const factory = fault === 'connect' ? async () => { throw new Error('secret-canary'); } : f.factory;
  await expect(openRabbitPrerequisites(externalConfig(), new AbortController().signal, factory)).rejects.toThrow('rabbit_prerequisite_failed');
  expect(f.native.consume).not.toHaveBeenCalled();
  expect(f.connection.close).toHaveBeenCalledTimes(fault === 'connect' ? 0 : 1);
});

test.each(['connect', 'channel'])('late %s acquisition after abort is joined and closed, never consumed', async (stage) => {
  const pending = deferred<void>(); const f = rabbitClientFixture(); const controller = new AbortController();
  const late = new FakeRabbitConnection();
  if (stage === 'channel') f.connection.createChannel.mockImplementation(async () => { await pending.promise; return f.native; });
  const factory = stage === 'connect' ? async () => { await pending.promise; return late; } : f.factory;
  const opening = openRabbitPrerequisites(externalConfig(), controller.signal, factory).catch((error: unknown) => error);
  if (stage === 'channel') await until(() => f.connection.createChannel.mock.calls.length === 1);
  controller.abort(); pending.resolve();
  expect(await opening).toMatchObject({ message: 'rabbit_prerequisite_failed' });
  expect((stage === 'connect' ? late : f.connection).close).toHaveBeenCalledTimes(1);
  expect(f.native.consume).not.toHaveBeenCalled(); expect(late.channel.consume).not.toHaveBeenCalled();
});

test('ACK exception is redacted and cannot authorize retrying the original message on the old channel', async () => {
  const f = rabbitClientFixture(); const rabbit = await openRabbitPrerequisites(externalConfig(), new AbortController().signal, f.factory);
  const messages: LiveRabbitDelivery[] = [];
  await rabbit.channel.prefetch(1);
  await rabbit.channel.consume(liveQueueName, (message) => { if (message) messages.push(message); }, { noAck: false, exclusive: true });
  f.native.handler?.(rawMessage());
  const message = messages[0]; if (!message) throw new Error('missing_delivery');
  f.native.ack.mockImplementation(() => { throw new Error('secret-canary'); });
  expect(() => rabbit.channel.ack(message)).toThrow('rabbit_ack_refused');
  expect(() => rabbit.channel.ack(message)).toThrow('rabbit_ack_refused');
  expect(f.native.ack).toHaveBeenCalledTimes(1); await rabbit.close();
});

test('partial channel failure joins asynchronous connection cleanup before reporting failure', async () => {
  const f = rabbitClientFixture(); const cleanup = deferred<void>();
  f.connection.createChannel.mockRejectedValue(new Error('secret-canary'));
  f.connection.close.mockReturnValue(cleanup.promise);
  let settled = false;
  const opening = openRabbitPrerequisites(externalConfig(), new AbortController().signal, f.factory).catch(() => { settled = true; });
  await until(() => f.connection.close.mock.calls.length === 1);
  expect(settled).toBe(false);
  cleanup.resolve(); await opening; expect(settled).toBe(true);
});

test('graceful close joins channel handshake before closing its connection', async () => {
  const f = rabbitClientFixture(); const channelClosed = deferred<void>();
  const rabbit = await openRabbitPrerequisites(externalConfig(), new AbortController().signal, f.factory);
  f.native.close.mockReturnValue(channelClosed.promise);
  const closing = rabbit.close();
  await until(() => f.native.close.mock.calls.length === 1);
  expect(f.connection.close).not.toHaveBeenCalled();
  channelClosed.resolve(); await closing;
  expect(f.connection.close).toHaveBeenCalledTimes(1);
});

test('channel close failure still attempts and joins connection cleanup, then returns only a bounded error', async () => {
  const f = rabbitClientFixture(); const connectionClosed = deferred<void>();
  const rabbit = await openRabbitPrerequisites(externalConfig(), new AbortController().signal, f.factory);
  f.native.close.mockRejectedValue(new Error('secret-canary'));
  f.connection.close.mockReturnValue(connectionClosed.promise);
  let settled = false;
  const closing = rabbit.close().catch((error: unknown) => { settled = true; return error; });
  await until(() => f.connection.close.mock.calls.length === 1);
  expect(settled).toBe(false);
  connectionClosed.resolve();
  expect(await closing).toMatchObject({ message: 'rabbit_prerequisite_failed' });
});
