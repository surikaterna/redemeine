import { randomUUID } from 'node:crypto';
import { connect, type Channel, type ConfirmChannel } from 'amqplib';
import { NativeRabbitClose } from '../src/infrastructure/nativeRabbitClose';
import { budgets, exchangeName, partitionId, queueName, sourceCollection, QualificationError } from './plan';
import { assert, integer, record } from './schema';
import { assertCurrent, within, type Unjoined } from './cancellation';
import { sha256 } from './receipts';

interface TransportEvents {
  on(event: 'error' | 'return' | 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}
export interface TransportChannel extends TransportEvents, Pick<Channel, 'close' | 'prefetch' | 'consume' | 'cancel' | 'nack'> {}
export interface TransportConfirmChannel extends TransportChannel { publish: ConfirmChannel['publish'] }
export interface TransportConnection extends TransportEvents {
  close(): Promise<void>;
  createChannel(): Promise<TransportChannel>;
  createConfirmChannel(): Promise<TransportConfirmChannel>;
}
export interface TransportDependencies {
  connect?: (uri: string, options: { timeout: number }) => Promise<TransportConnection>;
  unjoined?: Unjoined;
}
interface Turn {
  current(): void;
  step<T>(label: string, operation: () => Promise<T>): Promise<T>;
}

async function closeTracked(label: string, tracker: NativeRabbitClose | undefined, unjoined: Unjoined): Promise<void> {
  if (!tracker) return;
  await within(label, () => tracker.close(), new AbortController().signal, performance.now() + budgets.commandMs, unjoined);
}

async function lateClose(value: TransportEvents & { close(): Promise<void> }, label: string, unjoined: Unjoined): Promise<void> {
  const tracker = new NativeRabbitClose(value); value.on('error', () => {});
  await closeTracked(label, tracker, unjoined);
}

async function withChannel<T, C extends TransportChannel>(uri: string, signal: AbortSignal, dependencies: TransportDependencies,
  factory: (connection: TransportConnection) => Promise<C>, work: (channel: C, turn: Turn) => Promise<T>): Promise<T> {
  const url = new URL(uri); assert(url.hostname === '127.0.0.1', 'nonloopback_transport_refused');
  const deadline = performance.now() + budgets.scenarioMs; const unjoined = dependencies.unjoined ?? (() => {});
  const connection = await within('transport_connect', () => (dependencies.connect ?? connect)(uri, { timeout: 5000 }), signal,
    deadline, unjoined, (value) => lateClose(value, 'late_connection_close', unjoined));
  const connectionClose = new NativeRabbitClose(connection); connection.on('error', () => {});
  let channelClose: NativeRabbitClose | undefined;
  const turn: Turn = { current: () => assertCurrent(signal, deadline),
    step: (label, operation) => within(label, operation, signal, deadline, unjoined) };
  try {
    const channel = await within('transport_channel', () => factory(connection), signal, deadline, unjoined,
      (value) => lateClose(value, 'late_channel_close', unjoined));
    channelClose = new NativeRabbitClose(channel); channel.on('error', () => {});
    return await turn.step('transport_work', () => work(channel, turn));
  } finally {
    try { await closeTracked('transport_channel_close', channelClose, unjoined); }
    finally { await closeTracked('transport_connection_close', connectionClose, unjoined); }
  }
}

export async function redeliverOver20(uri: string, expectedCommitId: string, signal: AbortSignal, dependencies: TransportDependencies = {}) {
  return withChannel(uri, signal, dependencies, (connection) => connection.createChannel(), async (channel, turn) => {
    await turn.step('transport_prefetch', () => channel.prefetch(1, false));
    let count = 0; let ending = false; let maximumDeliveryCount = 0; const tag = 'hpq1-redelivery-probe';
    let complete: (value: Record<string, unknown>) => void = () => {}; let failed: (reason: unknown) => void = () => {};
    const result = new Promise<Record<string, unknown>>((resolve, reject) => { complete = resolve; failed = reject; });
    // Observe rejection even if consume-ok never arrives and the turn abandons this waiter.
    void result.catch(() => {});
    await turn.step('transport_consume', () => channel.consume(queueName, (message) => {
      if (ending) return;
      try {
        turn.current(); assert(message !== null, 'redelivery_cancelled'); if (!message) return;
        const body: unknown = JSON.parse(message.content.toString('utf8'));
        assert(record(body).id === expectedCommitId && message.properties.messageId === expectedCommitId, 'redelivery_identity_mismatch');
        const deliveryCount: unknown = message.properties.headers?.['x-delivery-count'];
        if (deliveryCount !== undefined) maximumDeliveryCount = Math.max(maximumDeliveryCount, integer(deliveryCount));
        count += 1; if (count > 1) assert(message.fields.redelivered, 'redelivery_flag_missing');
        if (count < 22) { channel.nack(message, false, true); return; }
        ending = true;
        void turn.step('transport_cancel', () => channel.cancel(tag)).then(() => {
          turn.current(); channel.nack(message, false, true);
          complete({ observedDeliveries: count, maximumDeliveryCount, scope: 'controlled_transport_fault', retainedCommit: true });
        }).catch(failed);
      } catch (error) { ending = true; failed(error); }
    }, { noAck: false, exclusive: false, consumerTag: tag }));
    const receipt = await turn.step('transport_redelivery', () => result);
    assert(maximumDeliveryCount >= 21, 'delivery_count_evidence_missing'); return receipt;
  });
}

export interface MalformedPublication { messageIdHash: string; sourceIdHash: string; payloadKind: 'fixed_invalid_json'; confirmRouted: true }

export async function publishMalformed(uri: string, sourceId: string, signal: AbortSignal, dependencies: TransportDependencies = {}): Promise<MalformedPublication> {
  return withChannel<MalformedPublication, TransportConfirmChannel>(uri, signal, dependencies, (connection) => connection.createConfirmChannel(), async (channel, turn) => {
    let returned = false; channel.on('return', () => { returned = true; });
    const messageId = randomUUID();
    await turn.step('transport_publish_confirm', () => new Promise<void>((resolve, reject) => {
      channel.publish(exchangeName, '', Buffer.from('not-a-json-commit'), { persistent: true, mandatory: true, messageId,
        contentType: 'application/json', headers: { collection: sourceCollection, partitionId, streamId: sourceId } },
      (error: unknown) => error || returned ? reject(new QualificationError('malformed_fixture_not_routed')) : resolve());
    }));
    turn.current(); return { messageIdHash: sha256(messageId), sourceIdHash: sha256(sourceId), payloadKind: 'fixed_invalid_json', confirmRouted: true };
  });
}
