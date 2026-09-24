import type {
  CommitProjectionSourceCommitRequest,
  ProjectionSourceCommitProgress,
  ProjectionSourceEvent,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import { projectionUuidToBase64Url22 } from '@redemeine/projection-runtime-core';

export const sourceUuid = (value: number): string => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

export const inlineProgress = (count: number): Readonly<Record<ProjectionUuidBase64Url22, number>> => {
  const entries = Array.from({ length: count }, (_, index) => [projectionUuidToBase64Url22(sourceUuid(index + 1)), 0] as const);
  return Object.fromEntries(entries) as Readonly<Record<ProjectionUuidBase64Url22, number>>;
};

const event = (index: number, count: number, sequence: number): ProjectionSourceEvent => ({
  eventId: sourceUuid(500_000 + sequence * 100 + index),
  eventIndex: index,
  streamVersion: sequence * count + index,
  aggregateType: 'Benchmark',
  aggregateId: 'source',
  type: 'Changed',
  payload: { index },
  timestamp: '2026-09-22T00:00:00.000Z'
});

const events = (count: number, sequence: number): [ProjectionSourceEvent, ...ProjectionSourceEvent[]] => [
  event(0, count, sequence),
  ...Array.from({ length: count - 1 }, (_, index) => event(index + 1, count, sequence))
];

export const request = (
  name: string,
  sourceId: string,
  sequence: number,
  eventCount: number,
  targetDocumentId: string | null,
  expectedRevision: number | null,
  progress: ProjectionSourceCommitProgress
): CommitProjectionSourceCommitRequest<{ sequence: number }> => ({
  version: 1,
  mode: 'atomic-all',
  projectionName: name,
  projectionGeneration: 'v1',
  commit: {
    streamId: sourceId,
    commitId: sourceUuid(900_000 + sequence),
    commitSequence: sequence,
    events: events(eventCount, sequence)
  },
  finalDocuments:
    targetDocumentId === null
      ? []
      : [
          {
            targetDocumentId,
            expectedRevision,
            finalDocument: { sequence }
          }
        ],
  stagedLinks: [],
  progress
});
