import type { Checkpoint } from '../contracts';

export type CommitAtomicWrite<TState> = {
  documents: Array<{ documentId: string; state: TState; checkpoint: Checkpoint }>;
  links: Array<{ aggregateType: string; aggregateId: string; targetDocId: string }>;
  cursorKey: string;
  cursor: Checkpoint;
  dedupe: { upserts: Array<{ key: string; checkpoint: Checkpoint }> };
};
