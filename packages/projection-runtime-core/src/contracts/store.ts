import type { Checkpoint } from '../types';

export interface ProjectionStoreAtomicManyResult {
  highestWatermark: Checkpoint;
  byLaneWatermark?: Readonly<Record<string, Checkpoint>>;
}

export type ProjectionDocumentWriteMode = 'full' | 'patch';

export interface ProjectionStoreDocumentWrite<TState = unknown> {
  documentId: string;
  mode: ProjectionDocumentWriteMode;
  fullDocument?: TState;
  patch?: Record<string, unknown>;
  checkpoint: Checkpoint;
}
