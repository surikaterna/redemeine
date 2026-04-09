import type { ProjectionCheckpoint } from './commitFeed';

export interface ProjectionMetadataEnvelope {
  projectionName: string;
  documentId: string;
  version: number;
  lastCheckpoint: ProjectionCheckpoint;
  updatedAt: string;
  persistenceMode: 'patch' | 'document';
}

export type ProjectedDocument<TDocument extends Record<string, unknown> = Record<string, unknown>> = TDocument & {
  _projection: ProjectionMetadataEnvelope;
};

export interface Rfc6902Operation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

export interface PersistProjectionPatch {
  projectionName: string;
  documentId: string;
  expectedVersion?: number;
  operations: Rfc6902Operation[];
  metadata: ProjectionMetadataEnvelope;
}

export interface PersistProjectionDocument {
  projectionName: string;
  documentId: string;
  expectedVersion?: number;
  document: ProjectedDocument;
}

export interface PatchProjectionPersistenceContract {
  persistPatch(change: PersistProjectionPatch): Promise<void>;
}

export interface DocumentProjectionPersistenceContract {
  persistDocument(change: PersistProjectionDocument): Promise<void>;
}

export interface ProjectionReadContract<TDocument extends Record<string, unknown> = Record<string, unknown>> {
  loadDocument(
    projectionName: string,
    documentId: string
  ): Promise<ProjectedDocument<TDocument> | null>;
}
