import type { ProjectionSourceCommit, ProjectionSourceEvent } from '@redemeine/projection-runtime-core';

export const firstSource = '00000000-0000-4000-8000-000000000001';
export const secondSource = '00000000-0000-4000-8000-000000000002';

function event(sequence: number, index: number, amount: number, type = 'Added', target = 'shared'): ProjectionSourceEvent {
  return { eventId: `00000000-0000-4000-8002-${String(sequence * 10 + index).padStart(12, '0')}`,
    eventIndex: index, streamVersion: sequence * 10 + index, aggregateType: 'ModelCounter', aggregateId: 'model:aggregate',
    type, payload: { amount, target }, timestamp: '2026-09-29T00:00:00.000Z' };
}

export function modelCommit(sequence: number, sourceId = firstSource): ProjectionSourceCommit {
  return { streamId: sourceId, commitId: `00000000-0000-4000-8001-${String(sequence).padStart(12, '0')}`,
    commitSequence: sequence, events: [event(sequence, 0, 1)] };
}

export function referenceScenario(): readonly ProjectionSourceCommit[] {
  return [
    { ...modelCommit(42), events: [event(42, 0, 2), event(42, 1, 3), event(42, 2, 100, 'Ignored'),
      event(42, 3, 99, 'Added', 'none')] },
    { ...modelCommit(43), events: [event(43, 0, 4)] },
    { ...modelCommit(44), events: [event(44, 0, 100, 'Ignored')] },
    { ...modelCommit(7, secondSource), events: [event(7, 0, 5)] }
  ];
}
