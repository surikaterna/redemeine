import type { ProjectionEvent } from '@redemeine/projection-runtime-core';

import type {
  ProjectionWorkerCommit,
  ProjectionWorkerPushManyResult,
  ProjectionWorkerPushContract,
  ProjectionWorkerReplayPollingAdapter,
  ProjectionWorkerReplayPollingAdapterOptions,
  ProjectionWorkerReplayPollingResult
} from './contracts';

function defaultDedupeKey(event: ProjectionEvent): string {
  return `${event.aggregateType}:${event.aggregateId}:${event.type}:${event.sequence}`;
}

function extractWorkerNack(
  workerResult: ProjectionWorkerPushManyResult,
  eventsByCommitIndex: readonly ProjectionEvent[]
): ProjectionWorkerReplayPollingResult['nack'] {
  for (let index = 0; index < workerResult.items.length; index += 1) {
    const item = workerResult.items[index];
    if (!item) {
      continue;
    }

    if (item.decision.status === 'nack') {
      const event = eventsByCommitIndex[index];
      if (!event) {
        continue;
      }

      return {
        event,
        decision: item.decision
      };
    }
  }

  return undefined;
}

export function createProjectionWorkerReplayPollingAdapter(
  options: ProjectionWorkerReplayPollingAdapterOptions
): ProjectionWorkerReplayPollingAdapter {
  const dedupeKey = options.dedupeKey ?? defaultDedupeKey;
  let cursor = options.initialCursor ?? { sequence: 0 };
  const seen = new Set<string>();

  return {
    getCursor() {
      return cursor;
    },
    async pollAndPush(batchSize: number) {
      const cursorStart = cursor;
      const batch = await options.polling.poll(cursorStart, batchSize);
      const commits: ProjectionWorkerCommit[] = [];
      const eventsByCommitIndex: ProjectionEvent[] = [];
      const stagedDedupeKeys = new Set<string>();
      let dedupedCount = 0;

      for (const event of batch.events) {
        const key = dedupeKey(event);
        if (seen.has(key) || stagedDedupeKeys.has(key)) {
          dedupedCount += 1;
          continue;
        }

        stagedDedupeKeys.add(key);
        eventsByCommitIndex.push(event);
        commits.push(options.toCommit(event));
      }

      const workerResult = commits.length === 0
        ? { items: [] }
        : await options.worker.pushMany(commits);

      const nack = extractWorkerNack(workerResult, eventsByCommitIndex);

      if (!nack) {
        for (const key of stagedDedupeKeys) {
          seen.add(key);
        }
        cursor = batch.nextCursor;
      }

      return {
        cursorStart,
        cursorEnd: nack ? cursorStart : batch.nextCursor,
        polledCount: batch.events.length,
        pushedCount: commits.length,
        dedupedCount,
        nack
      };
    }
  };
}
