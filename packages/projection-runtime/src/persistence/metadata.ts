import type { ProjectionCheckpoint } from '../contracts/commitFeed';
import type { ProjectedDocument, ProjectionMetadataEnvelope } from '../contracts/persistence';
import type { ProjectionPersistenceMode } from './modeSelection';

export interface BuildProjectionMetadataParams {
  projectionName: string;
  documentId: string;
  checkpoint: ProjectionCheckpoint;
  previous?: ProjectionMetadataEnvelope;
  mode: ProjectionPersistenceMode;
  updatedAt?: string;
}

export function buildProjectionMetadata(params: BuildProjectionMetadataParams): ProjectionMetadataEnvelope {
  const nextVersion = (params.previous?.version ?? 0) + 1;

  return {
    projectionName: params.projectionName,
    documentId: params.documentId,
    version: nextVersion,
    lastCheckpoint: params.checkpoint,
    updatedAt: params.updatedAt ?? new Date().toISOString(),
    persistenceMode: params.mode
  };
}

export function withProjectionMetadata<TState extends Record<string, unknown>>(
  state: TState,
  metadata: ProjectionMetadataEnvelope
): ProjectedDocument<TState> {
  return {
    ...state,
    _projection: metadata
  };
}
