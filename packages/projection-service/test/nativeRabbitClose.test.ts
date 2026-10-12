import { openBrokerRabbit } from '../src/infrastructure/rabbitBroker';
import { openRabbitPrerequisites } from '../src/infrastructure/rabbit';
import { RabbitChannelAdapter } from '../src/infrastructure/rabbitChannel';
import { externalConfig } from './support/mongoClient';
import { createNativeRabbit } from './support/nativeRabbit.cjs';
import { rabbitClientFixture } from './support/rabbitClient';
import { deferred, until } from './support/deferred';

test.each(['broker', 'prerequisite'])('%s reconciles actual pinned native channel/connection close without retrying illegal operations', async (mode) => {
  const fixture = createNativeRabbit();
  expect(fixture.version).toBe('2.0.1');
  const resource = await (mode === 'broker' ? openBrokerRabbit : openRabbitPrerequisites)(
    externalConfig(), new AbortController().signal, async () => fixture.model);
  const native = fixture.channels[0]; if (!native) throw new Error('missing_native_channel');
  const channelClose = jest.spyOn(native, 'close'); const connectionClose = jest.spyOn(fixture.model, 'close');
  const cancel = jest.spyOn(native, 'cancel');
  expect(native.listenerCount('close')).toBe(4);
  fixture.closeConnection();
  expect(fixture.state()).toEqual({ channelClosed: true, connectionClosed: true, network: false });
  await resource.channel.cancel('stale-consumer'); await resource.close(); await resource.close();
  expect(channelClose).not.toHaveBeenCalled(); expect(connectionClose).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  expect(native.listenerCount('close')).toBe(2); expect(native.listenerCount('error')).toBe(1);
  expect(fixture.model.listenerCount('close')).toBe(1); expect(fixture.model.listenerCount('error')).toBe(1);
});

test('actual native channel-only closure allows the still-open connection to complete its close handshake once', async () => {
  const fixture = createNativeRabbit();
  const resource = await openBrokerRabbit(externalConfig(), new AbortController().signal, async () => fixture.model);
  const connectionClose = jest.spyOn(fixture.model, 'close');
  fixture.closeChannel();
  expect(fixture.state().connectionClosed).toBe(false);
  await resource.close(); await resource.close();
  expect(connectionClose).toHaveBeenCalledTimes(1);
  expect(fixture.state()).toEqual({ channelClosed: true, connectionClosed: true, network: false });
});

test('actual native in-flight close RPC settles on confirmed socket closure without duplicate close handshakes', async () => {
  const fixture = createNativeRabbit({ suspendClose: true });
  const resource = await openBrokerRabbit(externalConfig(), new AbortController().signal, async () => fixture.model);
  let settled = false;
  const closing = resource.close().then(() => { settled = true; });
  const channelJoin = resource.channel.close();
  await until(() => fixture.frames.some((frame) => frame.method === 'ChannelClose'));
  expect(settled).toBe(false); expect(fixture.state().channelClosed).toBe(false);
  fixture.closeConnection();
  await closing; await channelJoin;
  expect(fixture.frames.filter((frame) => frame.method === 'ChannelClose')).toHaveLength(1);
  expect(fixture.frames.filter((frame) => frame.method === 'ConnectionClose')).toHaveLength(0);
  expect(fixture.state()).toEqual({ channelClosed: true, connectionClosed: true, network: false });
});

test('actual native cancel rejection during socket failure reconciles only the observed close', async () => {
  const fixture = createNativeRabbit();
  const resource = await openBrokerRabbit(externalConfig(), new AbortController().signal, async () => fixture.model);
  const cancelling = resource.channel.cancel('native-consumer');
  fixture.closeConnection();
  await expect(cancelling).resolves.toBeUndefined();
  await resource.close();
});

test('connection close observed while acquiring channel is retained before any further await', async () => {
  const fixture = createNativeRabbit();
  fixture.model.createChannel = async () => { fixture.closeConnection(); throw new Error('acquisition_lost'); };
  const close = jest.spyOn(fixture.model, 'close');
  await expect(openBrokerRabbit(externalConfig(), new AbortController().signal, async () => fixture.model))
    .rejects.toThrow('rabbit_prerequisite_failed');
  expect(fixture.state().connectionClosed).toBe(true);
  expect(close).not.toHaveBeenCalled();
  expect(fixture.model.listenerCount('close')).toBe(1);
});

test('one owned close is joined; error-only and synthetic adapter close do not settle it, native close does', async () => {
  const f = rabbitClientFixture(); const pending = deferred<void>();
  f.native.close.mockReturnValue(pending.promise);
  const adapter = new RabbitChannelAdapter(f.native);
  let settled = false;
  const first = adapter.close().then(() => { settled = true; });
  const second = adapter.close();
  await until(() => f.native.close.mock.calls.length === 1);
  f.native.emit('error', new Error('secret-canary')); adapter.invalidate('close');
  await Promise.resolve(); expect(settled).toBe(false);
  f.native.emit('close'); await first; await second;
  pending.reject(new Error('late_close_rpc_rejection'));
  await Promise.resolve();
  expect(f.native.close).toHaveBeenCalledTimes(1);
  expect(f.native.listenerCount('close')).toBe(0); expect(f.native.listenerCount('error')).toBe(0);
});

test('native close preceding rejected close RPC reconciles, while unconfirmed error-only rejection stays a failure', async () => {
  const confirmed = rabbitClientFixture();
  confirmed.native.close.mockImplementation(async () => { confirmed.native.emit('close'); throw new Error('already_closed'); });
  const adapter = new RabbitChannelAdapter(confirmed.native);
  await expect(adapter.close()).resolves.toBeUndefined();
  const uncertain = rabbitClientFixture();
  uncertain.native.close.mockImplementation(async () => { uncertain.native.emit('error', new Error('error_only')); throw new Error('no_close'); });
  const unknown = new RabbitChannelAdapter(uncertain.native);
  await expect(unknown.close()).rejects.toThrow('rabbit_prerequisite_failed');
  expect(uncertain.native.listenerCount('close')).toBeGreaterThan(0);
  uncertain.native.emit('close');
  await expect(unknown.close()).resolves.toBeUndefined();
});

test('unconfirmed cancel failure is not swallowed merely because the adapter was invalidated', async () => {
  const f = rabbitClientFixture(); const adapter = new RabbitChannelAdapter(f.native);
  f.native.cancel.mockImplementation(async () => { f.native.emit('error', new Error('secret-canary')); throw new Error('cancel_uncertain'); });
  await expect(adapter.cancel('consumer')).rejects.toThrow('rabbit_prerequisite_failed');
  await adapter.close();
});

test('in-flight connection cleanup joins an observed native close and observes its late RPC rejection', async () => {
  const f = rabbitClientFixture(); const pending = deferred<void>();
  const resource = await openRabbitPrerequisites(externalConfig(), new AbortController().signal, f.factory);
  f.connection.close.mockReturnValue(pending.promise);
  const closing = resource.close();
  await until(() => f.connection.close.mock.calls.length === 1);
  f.connection.emit('close'); await closing;
  pending.reject(new Error('late_connection_rejection'));
  await Promise.resolve();
  expect(f.connection.listenerCount('close')).toBe(0); expect(f.connection.listenerCount('error')).toBe(0);
});
