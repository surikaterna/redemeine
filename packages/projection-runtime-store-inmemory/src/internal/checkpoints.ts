import type { Checkpoint } from '@redemeine/projection-runtime-core';

export const cloneCheckpoint = (checkpoint: Checkpoint): Checkpoint => ({
  sequence: checkpoint.sequence,
  ...(checkpoint.timestamp ? { timestamp: checkpoint.timestamp } : {})
});

export const chooseHigherWatermark = (current: Checkpoint | null, next: Checkpoint): Checkpoint => {
  if (!current || next.sequence > current.sequence) {
    return cloneCheckpoint(next);
  }

  if (next.sequence === current.sequence && next.timestamp && (!current.timestamp || next.timestamp > current.timestamp)) {
    return cloneCheckpoint(next);
  }

  return current;
};

export const matchesCheckpoint = (left: Checkpoint, right: Checkpoint): boolean =>
  left.sequence === right.sequence && (left.timestamp ?? null) === (right.timestamp ?? null);
