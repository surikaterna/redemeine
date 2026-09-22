import type { ProjectionQueueRegistryManifest, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { IBaseEvent, ICommit } from 'tapeworm';
import type { ProjectionRabbitChannel, RabbitDelivery } from '../src';
import {
  normalizeProjectionMigrationDefinitions,
  projectionDefinitionRegistryDigest,
  projectionMigrationDefinitionHash,
  projectionMigrationRuntimeConfigurationDigest,
  projectionQueueRegistryDigest
} from '../src';
import { identityConfigurations, runtimeDefinitions } from './migrationRuntimeDefinitions';

export const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
export const PARTITION_ID = 'orders';
export const HASH = `sha256:${'1'.repeat(64)}` as const;

export interface StackState {
  count: number;
  seen: number[];
}

export interface StackEvent extends IBaseEvent {
  aggregateType: string;
  aggregateId: string;
  payload: { amount: number };
  timestamp: string;
}

export function tapewormCommit(sequence: number, amounts: readonly number[]): ICommit<StackEvent> {
  let offset = sequence === 0 ? 0 : 2;
  return {
    id: `22222222-2222-4222-8222-${String(sequence).padStart(12, '0')}`,
    partitionId: PARTITION_ID,
    streamId: SOURCE_ID,
    commitSequence: sequence,
    headers: { trace: `commit-${sequence}` },
    metadata: { source: 'real-stack' },
    events: amounts.map((amount, index) => ({
      id: `33333333-3333-4333-8333-${String(offset + index).padStart(12, '0')}`,
      type: 'Changed',
      version: offset + index,
      aggregateType: 'Order',
      aggregateId: 'one',
      payload: { amount },
      timestamp: '2026-09-22T00:00:00.000Z',
      headers: { event: index },
      metadata: { sequence }
    }))
  };
}

export function stackDefinitions() {
  return runtimeDefinitions('v1');
}

export function stackManifest(
  queue: string,
  generation = 'v1',
  sourceStartAnchors: Readonly<Record<string, number>> = { [SOURCE_ID]: 0 },
  artifactDigest: `sha256:${string}` = HASH
): ProjectionQueueRegistryManifest {
  const configurations = normalizeProjectionMigrationDefinitions(runtimeDefinitions(generation), identityConfigurations);
  const definitions = configurations.map((configuration) => ({
    projectionName: configuration.projectionName,
    generation,
    definitionHash: projectionMigrationDefinitionHash(configuration, artifactDigest),
    sourceSelectors: [configuration.from.aggregateType]
  }));
  const payload = {
    version: 1 as const,
    queueId: queue,
    registryGeneration: generation,
    identity: {
      version: 1 as const,
      normalizedDefinitionRegistryDigest: projectionDefinitionRegistryDigest(definitions),
      normalizedRuntimeConfigurationDigest: projectionMigrationRuntimeConfigurationDigest(configurations),
      executableCodeArtifactDigest: artifactDigest
    },
    definitions,
    sourceStartAnchors
  };
  return { ...payload, manifestId: projectionQueueRegistryDigest(payload) };
}

export function adaptChannel(channel: Channel): ProjectionRabbitChannel {
  const originals = new WeakMap<object, ConsumeMessage>();
  const original = (message: RabbitDelivery): ConsumeMessage => {
    const value = originals.get(message);
    if (!value) throw new Error('Missing original Rabbit delivery.');
    return value;
  };
  return {
    assertExchange: (name, type, options) => channel.assertExchange(name, type, options),
    assertQueue: (name, options) => channel.assertQueue(name, options),
    prefetch: (count) => channel.prefetch(count),
    consume: (name, handler, options) =>
      channel.consume(
        name,
        (message) => {
          if (!message) return handler(null);
          const projected: RabbitDelivery = {
            content: message.content,
            fields: { deliveryTag: message.fields.deliveryTag, redelivered: message.fields.redelivered },
            properties: { ...(message.properties.messageId ? { messageId: message.properties.messageId } : {}) }
          };
          originals.set(projected, message);
          handler(projected);
        },
        options
      ),
    cancel: (tag) => channel.cancel(tag),
    ack: (message) => channel.ack(original(message)),
    nack: (message, allUpTo, requeue) => channel.nack(original(message), allUpTo, requeue)
  };
}

export function toProjectionCommit(commit: ICommit<StackEvent>): ProjectionSourceCommit {
  const mapped = commit.events.map((event, eventIndex) => ({
    eventId: event.id,
    eventIndex,
    streamVersion: event.version ?? -1,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    type: event.type,
    payload: event.payload,
    timestamp: event.timestamp
  }));
  const first = mapped[0];
  if (!first) throw new Error('A Tapeworm commit must contain at least one event.');
  return {
    streamId: commit.streamId,
    commitId: commit.id,
    commitSequence: commit.commitSequence,
    events: [first, ...mapped.slice(1)]
  };
}
