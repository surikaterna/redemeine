import { connect, type ChannelModel } from 'amqplib';
import type { ExternalConfig } from './mongo';
import { assertActive, assertTimeout, closeOnce, InfrastructureError, retainUntilClosed } from './failure';
import { liveQueueName, RabbitChannelAdapter, type NativeRabbitChannel, type RabbitEvents } from './rabbitChannel';
import { NativeRabbitClose } from './nativeRabbitClose';

export interface RabbitConnection extends RabbitEvents, Pick<ChannelModel, 'close'> {
  createChannel(): Promise<NativeRabbitChannel>;
}
export interface RabbitSocketOptions { readonly timeout: number; readonly clientProperties?: { readonly connection_name: string } }
export type RabbitConnector = (uri: string, options: RabbitSocketOptions) => Promise<RabbitConnection>;

export function connectRabbit(uri: string, options: RabbitSocketOptions): Promise<RabbitConnection> { return connect(uri, options); }

export async function openRabbitPrerequisites(config: ExternalConfig, signal: AbortSignal, factory: RabbitConnector = connectRabbit) {
  assertActive(signal);
  assertTimeout(config.connectTimeoutMs);
  let connection: RabbitConnection;
  try { connection = await factory(config.external.rabbitmqUri, { timeout: config.connectTimeoutMs }); }
  catch { throw new InfrastructureError('rabbit_prerequisite_failed'); }
  const nativeClosure = new NativeRabbitClose(connection);
  let channel: RabbitChannelAdapter | undefined;
  let lost = false;
  const disconnected = () => { lost = true; channel?.invalidate('error'); };
  connection.on('error', disconnected);
  const detach = () => { connection.removeListener('close', closed); connection.removeListener('error', disconnected); };
  const closed = () => { disconnected(); detach(); };
  connection.on('close', closed);
  const close = closeOnce(async () => {
    const channelClosed = await (channel ? channel.close().then(() => true, () => false) : Promise.resolve(true));
    try { await nativeClosure.close(); detach(); }
    catch { throw new InfrastructureError('rabbit_prerequisite_failed'); }
    if (!channelClosed) throw new InfrastructureError('rabbit_prerequisite_failed');
  });
  try {
    assertActive(signal);
    channel = new RabbitChannelAdapter(await connection.createChannel());
    assertActive(signal);
    if (lost) throw new InfrastructureError('rabbit_prerequisite_failed');
    await channel.checkQueue(liveQueueName);
    assertActive(signal);
    if (lost) throw new InfrastructureError('rabbit_prerequisite_failed');
    return { channel, queueFacts: channel.queueFacts(), close };
  } catch {
    await retainUntilClosed(close);
    throw new InfrastructureError('rabbit_prerequisite_failed');
  }
}
