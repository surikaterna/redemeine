import type { Channel } from 'amqplib';
import type { SagaRabbitChannel } from '../src/index';
import type { CrashSignal } from './crashIpc';
import { retryQueue } from './crashBroker';

export type CrashConsumerChannel = SagaRabbitChannel & Pick<Channel, 'bindQueue' | 'close'>;

function deaths(value: unknown): unknown {
  if (!Array.isArray(value)) return value === undefined ? undefined : 'invalid-shape';
  return value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('queue' in entry) ||
        !('reason' in entry) || !('count' in entry)) return 'invalid-entry';
    return { queue: entry.queue === retryQueue ? retryQueue : 'unexpected-queue',
      reason: entry.reason === 'expired' ? 'expired' : 'unexpected-reason',
      count: typeof entry.count === 'number' ? entry.count : 'invalid-count' };
  });
}

/** One adapter is both the consuming and retry-closing channel; broker ACK is never simulated. */
export function observedConsumerChannel(base: CrashConsumerChannel, report: (signal: CrashSignal) => void): CrashConsumerChannel {
  return {
    ack: (message, allUpTo) => {
      base.ack(message, allUpTo);
      report({ kind: 'ack', messageId: message.properties.messageId });
    },
    nack: base.nack.bind(base),
    assertExchange: base.assertExchange.bind(base),
    assertQueue: base.assertQueue.bind(base),
    bindQueue: base.bindQueue.bind(base),
    cancel: base.cancel.bind(base),
    prefetch: base.prefetch.bind(base),
    close: base.close.bind(base),
    consume: (queue, callback, options) => base.consume(queue, message => {
      if (message) report({ kind: 'delivery', messageId: message.properties.messageId,
        redelivered: message.fields.redelivered, attempt: message.properties.headers?.['rdm-saga-retry-attempt'],
        deaths: deaths(message.properties.headers?.['x-death']) });
      callback(message);
    }, options)
  };
}
