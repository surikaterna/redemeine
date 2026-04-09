import type {
  DocumentProjectionPersistenceContract,
  PatchProjectionPersistenceContract,
  ProjectedDocument,
  ProjectionReadContract
} from '../contracts/persistence';

export type ProjectionPersistenceMode = 'patch' | 'document';

export interface ProjectionPersistenceCapabilities<
  TDocument extends Record<string, unknown> = Record<string, unknown>
> {
  preferredMode?: ProjectionPersistenceMode;
  patch?: PatchProjectionPersistenceContract;
  document?: DocumentProjectionPersistenceContract;
  read?: ProjectionReadContract<TDocument>;
}

export interface ResolvedProjectionPersistence<
  TDocument extends Record<string, unknown> = Record<string, unknown>
> {
  mode: ProjectionPersistenceMode;
  read: ProjectionReadContract<TDocument>;
  patch?: PatchProjectionPersistenceContract;
  document?: DocumentProjectionPersistenceContract;
}

type ReadCapable<TDocument extends Record<string, unknown>> = {
  loadDocument(
    projectionName: string,
    documentId: string
  ): Promise<ProjectedDocument<TDocument> | null>;
};

function asReadCapability<TDocument extends Record<string, unknown>>(
  value: unknown
): ProjectionReadContract<TDocument> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if ('loadDocument' in value && typeof (value as ReadCapable<TDocument>).loadDocument === 'function') {
    return value as ProjectionReadContract<TDocument>;
  }
  return undefined;
}

export function resolveProjectionPersistence<
  TDocument extends Record<string, unknown> = Record<string, unknown>
>(
  capabilities: ProjectionPersistenceCapabilities<TDocument>
): ResolvedProjectionPersistence<TDocument> {
  const { patch, document, preferredMode = 'patch' } = capabilities;

  if (!patch && !document) {
    throw new Error(
      'Projection runtime persistence configuration error: no persistence capability configured (expected patch and/or document capability).'
    );
  }

  const mode: ProjectionPersistenceMode =
    preferredMode === 'patch' ? (patch ? 'patch' : 'document') : document ? 'document' : 'patch';

  const read =
    capabilities.read ??
    asReadCapability<TDocument>(patch) ??
    asReadCapability<TDocument>(document);

  if (!read) {
    throw new Error(
      'Projection runtime persistence configuration error: no readable persistence capability configured (missing loadDocument implementation or explicit read capability).'
    );
  }

  return {
    mode,
    read,
    patch,
    document
  };
}
