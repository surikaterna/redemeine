import type { Checkpoint } from '@redemeine/projection-runtime-core';

export interface StoredDocument<TState> {
  state: TState;
  checkpoint: Checkpoint;
  updatedAt: string;
}
