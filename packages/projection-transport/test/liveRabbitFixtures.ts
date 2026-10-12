import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import type { ProjectionCompleteCommitRangeReader, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import type { LiveRabbitDelivery } from '../src/liveDeliveryGate';
import type { LiveRabbitChannel } from '../src/liveRabbitWorker';
import { OrderedLiveFeedFixture } from './orderedLiveFeedFixture';

export class LiveChannelFixture extends EventEmitter implements LiveRabbitChannel {
  handler: ((delivery: LiveRabbitDelivery | null) => void) | undefined;
  readonly checkQueue = jest.fn<(queue: string) => Promise<unknown>>().mockResolvedValue({});
  readonly prefetch = jest.fn<(count: number) => Promise<unknown>>().mockResolvedValue(undefined);
  readonly ack = jest.fn<(delivery: LiveRabbitDelivery) => void>();
  readonly cancel = jest.fn<(tag: string) => Promise<unknown>>().mockResolvedValue(undefined);
  readonly close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  readonly consume = jest.fn<LiveRabbitChannel['consume']>().mockImplementation(async (_queue, handler) => {
    this.handler = handler;
    return { consumerTag: 'consumer' };
  });
}

export function delivery(feed: OrderedLiveFeedFixture, commit: ProjectionSourceCommit, redelivered = false): LiveRabbitDelivery {
  const identity = feed.delivery(redelivered);
  const wire = { id: commit.commitId, streamId: commit.streamId, commitSequence: commit.commitSequence, partitionId: 'partition',
    events: commit.events.map((event) => ({ id: event.eventId, version: event.streamVersion,
      aggregateType: event.aggregateType, aggregateId: event.aggregateId, type: event.type, payload: event.payload, timestamp: event.timestamp })) };
  return { content: Buffer.from(JSON.stringify(wire)), fields: identity,
    properties: { messageId: commit.commitId, headers: { collection: 'commits', partitionId: 'partition', streamId: commit.streamId } } };
}

export function readerFor(commits: readonly ProjectionSourceCommit[]): ProjectionCompleteCommitRangeReader {
  return { capability: { completeCommitBoundaries: true, unslicedCommitEvents: true }, async readCompleteRange(request) {
    const found = commits.find((commit) => commit.streamId === request.sourceId && commit.commitSequence === request.throughSequence);
    return { status: 'complete', commits: found ? [{ commit: found, encodedByteLength: 500 }] : [],
      encodedByteLength: found ? 500 : 0, continuationAfterSequence: found?.commitSequence ?? request.afterSequence, hasMore: false };
  } };
}

export async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition timed out');
}
