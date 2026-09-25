import type { Channel } from 'amqplib';
import type { SagaRabbitChannel } from '../src';

export interface ReplacementObservation {
  readonly delivered: (messageId: string | undefined, redelivered: boolean) => void;
  readonly processed: (eventId: string, statuses: readonly string[]) => void;
  readonly acked: (messageId: string | undefined) => void;
}

export function observeReplacement(channel: Channel, observation: ReplacementObservation): SagaRabbitChannel {
  return {
    ack: (message, allUpTo) => {
      channel.ack(message, allUpTo);
      try { observation.acked(message.properties.messageId); } catch { /* Observation cannot change settlement. */ }
    },
    nack: channel.nack.bind(channel),
    assertExchange: channel.assertExchange.bind(channel),
    assertQueue: channel.assertQueue.bind(channel),
    cancel: channel.cancel.bind(channel),
    consume: (queue, callback, options) => channel.consume(queue, (message) => {
      if (message) {
        try { observation.delivered(message.properties.messageId, message.fields.redelivered); }
        catch { /* Observation cannot interrupt delivery. */ }
      }
      callback(message);
    }, options),
    prefetch: channel.prefetch.bind(channel)
  };
}
