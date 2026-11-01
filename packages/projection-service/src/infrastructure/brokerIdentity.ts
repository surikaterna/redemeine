import { randomUUID } from 'node:crypto';
import type { LiveDeliveryIdentity } from '@redemeine/projection-runtime-core';
import type { ExternalConfig } from './mongo';
import { integer, object, string, BrokerRefusal } from './brokerSchema';

export interface OwnedConsumerIdentity {
  readonly connectionLabel: string;
  readonly channelNumber: number;
  readonly peerHost: string;
  readonly peerPort: number;
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

export interface OwnedBrokerChannel {
  identity(): OwnedConsumerIdentity;
  owns(delivery: LiveDeliveryIdentity): boolean;
  assertCurrent(): void;
  consumerTag(): string | undefined;
}

export function connectionLabel(): string { return `redemeine-projection-${randomUUID()}`; }

export function socketHost(value: unknown): string { return string(value).replace(/^::ffff:/, ''); }

export function inspectOwnedIdentity(connection: unknown, channel: unknown, label: string, config: ExternalConfig): OwnedConsumerIdentity {
  const native = object(object(connection).connection);
  const stream = object(native.stream);
  const channelNumber = integer(object(channel).ch);
  if (channelNumber === 0) throw new BrokerRefusal('broker_channel_unidentified');
  const user = decodeURIComponent(new URL(config.external.rabbitmqUri).username) || 'guest';
  return Object.freeze({ connectionLabel: label, channelNumber, user,
    peerHost: socketHost(stream.localAddress), peerPort: integer(stream.localPort),
    host: socketHost(stream.remoteAddress), port: integer(stream.remotePort) });
}
