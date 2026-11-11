import type { ExternalConfig } from './mongo';
import { connectRabbit, type RabbitConnector, type RabbitConnection } from './rabbit';
import { connectionLabel, inspectOwnedIdentity } from './brokerIdentity';
import { queueArguments, bindingArguments } from './brokerTopology';
import { liveQueueName, RabbitChannelAdapter } from './rabbitChannel';
import { assertActive, closeOnce, connectionFailure, InfrastructureError, retainUntilClosed } from './failure';
import { NativeRabbitClose } from './nativeRabbitClose';
import { observeStartup, type StartupStage, type StartupObserver } from '../startupDiagnostics';

export async function openBrokerRabbit(config: ExternalConfig, signal: AbortSignal, factory: RabbitConnector = connectRabbit,
  observe?: StartupObserver) {
  assertActive(signal);
  const label = connectionLabel();
  let connection: RabbitConnection;
  try { connection = await factory(config.external.rabbitmqUri, { timeout: config.connectTimeoutMs, clientProperties: { connection_name: label } }); }
  catch (error) { throw connectionFailure(error, 'rabbit_prerequisite_failed'); }
  const nativeClosure = new NativeRabbitClose(connection);
  let adapter: RabbitChannelAdapter | undefined;
  let lost = false;
  const invalidate = () => { lost = true; adapter?.invalidate('error'); };
  const detach = () => { connection.removeListener('close', closed); connection.removeListener('error', invalidate); };
  const closed = () => { invalidate(); detach(); };
  connection.on('close', closed); connection.on('error', invalidate);
  const close = closeOnce(async () => {
    const channelClosed = await (adapter ? adapter.close().then(() => true, () => false) : Promise.resolve(true));
    await nativeClosure.close();
    detach();
    if (!channelClosed) throw new InfrastructureError('infrastructure_cleanup_failed');
  });
  let stage: StartupStage = 'rabbit_channel';
  try {
    assertActive(signal);
    observeStartup(observe, stage);
    const native = await connection.createChannel();
    adapter = new RabbitChannelAdapter(native, 'single_active', () => inspectOwnedIdentity(connection, native, label, config), config.external.exchange);
    const assertOpen = () => { assertActive(signal); if (lost) throw new InfrastructureError('rabbit_prerequisite_failed'); };
    assertOpen();
    stage = 'rabbit_identity'; observeStartup(observe, stage);
    adapter.identity();
    return { channel: adapter, close, assertOpen,
      async declare(nonce: string) {
        assertOpen();
        if (!native.assertQueue) throw new InfrastructureError('rabbit_prerequisite_failed');
        await native.assertQueue(liveQueueName, { durable: true, exclusive: false, autoDelete: false, arguments: queueArguments(nonce) });
      },
      async bind() {
        assertOpen();
        if (!native.bindQueue) throw new InfrastructureError('rabbit_prerequisite_failed');
        await native.bindQueue(liveQueueName, config.external.exchange, '', bindingArguments(config));
      } };
  } catch (error) { observeStartup(observe, stage, error); await retainUntilClosed(close); throw new InfrastructureError('rabbit_prerequisite_failed'); }
}
