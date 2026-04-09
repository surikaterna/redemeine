import type { ProjectionCheckpoint } from '../contracts/commitFeed';
import type {
  DocumentProjectionPersistenceContract,
  PatchProjectionPersistenceContract,
  PersistProjectionDocument,
  PersistProjectionPatch,
  ProjectedDocument,
  Rfc6902Operation
} from '../contracts/persistence';
import { buildProjectionMetadata, withProjectionMetadata } from './metadata';
import {
  resolveProjectionPersistence,
  type ProjectionPersistenceCapabilities,
  type ProjectionPersistenceMode,
  type ResolvedProjectionPersistence
} from './modeSelection';

interface StoredProjectionDocument {
  document: ProjectedDocument;
}

function keyFor(projectionName: string, documentId: string): string {
  return `${projectionName}::${documentId}`;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function decodePathSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function encodePathSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pathTokens(path: string): string[] {
  if (path === '') {
    return [];
  }
  const normalized = path.startsWith('/') ? path.slice(1) : path;
  if (!normalized) {
    return [];
  }
  return normalized.split('/').map(decodePathSegment);
}

function isIndexToken(token: string): boolean {
  return /^\d+$/.test(token);
}

function getContainer(root: unknown, tokens: string[]): { parent: any; key: string | undefined } {
  if (tokens.length === 0) {
    return { parent: undefined, key: undefined };
  }

  let current: any = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    const nextToken = tokens[i + 1];

    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Invalid RFC6902 path segment "${token}" for array.`);
      }
      if (current[index] === undefined || current[index] === null) {
        current[index] = isIndexToken(nextToken) ? [] : {};
      }
      current = current[index];
      continue;
    }

    if (typeof current !== 'object' || current === null) {
      throw new Error(`Cannot traverse RFC6902 path through non-object value at "${token}".`);
    }

    if (!(token in current) || current[token] === undefined || current[token] === null) {
      current[token] = isIndexToken(nextToken) ? [] : {};
    }
    current = current[token];
  }

  return { parent: current, key: tokens[tokens.length - 1] };
}

function removeAtPath(root: any, path: string): unknown {
  const tokens = pathTokens(path);
  if (tokens.length === 0) {
    throw new Error('Removing document root is not supported by this adapter.');
  }
  const { parent, key } = getContainer(root, tokens);
  if (Array.isArray(parent)) {
    if (key === undefined) {
      throw new Error('Missing RFC6902 array key.');
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw new Error(`Invalid RFC6902 remove index "${key}".`);
    }
    const [removed] = parent.splice(index, 1);
    return removed;
  }

  if (!parent || typeof parent !== 'object' || key === undefined) {
    throw new Error(`Invalid RFC6902 remove path "${path}".`);
  }

  const removed = parent[key];
  delete parent[key];
  return removed;
}

function applyOperation(target: Record<string, unknown>, operation: Rfc6902Operation): void {
  const tokens = pathTokens(operation.path);

  if (operation.op === 'remove') {
    removeAtPath(target, operation.path);
    return;
  }

  if (operation.op === 'move') {
    if (!operation.from) {
      throw new Error('RFC6902 move operation requires "from".');
    }
    const moved = removeAtPath(target, operation.from);
    applyOperation(target, {
      op: 'add',
      path: operation.path,
      value: moved
    });
    return;
  }

  if (operation.op === 'copy') {
    if (!operation.from) {
      throw new Error('RFC6902 copy operation requires "from".');
    }
    const fromTokens = pathTokens(operation.from);
    let source: any = target;
    for (const token of fromTokens) {
      source = source?.[token];
    }
    applyOperation(target, {
      op: 'add',
      path: operation.path,
      value: deepClone(source)
    });
    return;
  }

  if (operation.op === 'test') {
    const targetTokens = pathTokens(operation.path);
    let current: any = target;
    for (const token of targetTokens) {
      current = current?.[token];
    }
    const expected = JSON.stringify(operation.value);
    const actual = JSON.stringify(current);
    if (expected !== actual) {
      throw new Error(`RFC6902 test failed at path "${operation.path}".`);
    }
    return;
  }

  const { parent, key } = getContainer(target, tokens);

  if (tokens.length === 0) {
    throw new Error('Replacing document root is not supported by this adapter.');
  }

  if (Array.isArray(parent)) {
    if (key === undefined) {
      throw new Error('Missing RFC6902 array key.');
    }
    const index = key === '-' ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > parent.length) {
      throw new Error(`Invalid RFC6902 array index "${key}".`);
    }

    if (operation.op === 'add') {
      parent.splice(index, 0, deepClone(operation.value));
      return;
    }

    if (index >= parent.length) {
      throw new Error(`Invalid RFC6902 replace index "${key}".`);
    }
    parent[index] = deepClone(operation.value);
    return;
  }

  if (!parent || typeof parent !== 'object' || key === undefined) {
    throw new Error(`Invalid RFC6902 path "${operation.path}".`);
  }

  if (operation.op === 'replace' && !(key in parent)) {
    throw new Error(`RFC6902 replace path not found "${operation.path}".`);
  }
  parent[key] = deepClone(operation.value);
}

function applyRfc6902Patch(
  base: Record<string, unknown>,
  operations: readonly Rfc6902Operation[]
): Record<string, unknown> {
  const next = deepClone(base);
  for (const operation of operations) {
    applyOperation(next, operation);
  }
  return next;
}

function topLevelPatchOperations(
  current: Record<string, unknown>,
  next: Record<string, unknown>
): Rfc6902Operation[] {
  const operations: Rfc6902Operation[] = [];

  for (const key of Object.keys(current)) {
    if (!(key in next)) {
      operations.push({
        op: 'remove',
        path: `/${encodePathSegment(key)}`
      });
    }
  }

  for (const [key, value] of Object.entries(next)) {
    const op: 'add' | 'replace' = key in current ? 'replace' : 'add';
    operations.push({
      op,
      path: `/${encodePathSegment(key)}`,
      value
    });
  }

  return operations;
}

export interface InMemoryProjectionPersistenceAdapterOptions {
  now?: () => string;
}

export class InMemoryProjectionPersistenceAdapter
  implements
    PatchProjectionPersistenceContract,
    DocumentProjectionPersistenceContract,
    ProjectionPersistenceCapabilities
{
  readonly patch = this;

  readonly document = this;

  readonly read = this;

  readonly preferredMode?: ProjectionPersistenceMode;

  private readonly now: () => string;

  private readonly documents = new Map<string, StoredProjectionDocument>();

  constructor(options: InMemoryProjectionPersistenceAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async loadDocument(projectionName: string, documentId: string): Promise<ProjectedDocument | null> {
    const found = this.documents.get(keyFor(projectionName, documentId));
    return found ? deepClone(found.document) : null;
  }

  async persistPatch(change: PersistProjectionPatch): Promise<void> {
    const key = keyFor(change.projectionName, change.documentId);
    const existing = this.documents.get(key)?.document;
    const currentVersion = existing?._projection.version ?? 0;

    if (change.expectedVersion !== undefined && change.expectedVersion !== currentVersion) {
      throw new Error(
        `Projection version conflict for ${change.projectionName}/${change.documentId}: expected ${change.expectedVersion}, got ${currentVersion}.`
      );
    }

    const baseState = existing ? this.withoutProjection(existing) : {};
    const nextState = applyRfc6902Patch(baseState, change.operations);

    const metadata = buildProjectionMetadata({
      projectionName: change.projectionName,
      documentId: change.documentId,
      checkpoint: change.metadata.lastCheckpoint,
      previous: existing?._projection,
      mode: 'patch',
      updatedAt: this.now()
    });

    this.documents.set(key, {
      document: withProjectionMetadata(nextState, metadata)
    });
  }

  async persistDocument(change: PersistProjectionDocument): Promise<void> {
    const key = keyFor(change.projectionName, change.documentId);
    const existing = this.documents.get(key)?.document;
    const currentVersion = existing?._projection.version ?? 0;

    if (change.expectedVersion !== undefined && change.expectedVersion !== currentVersion) {
      throw new Error(
        `Projection version conflict for ${change.projectionName}/${change.documentId}: expected ${change.expectedVersion}, got ${currentVersion}.`
      );
    }

    this.documents.set(key, {
      document: deepClone(change.document)
    });
  }

  buildPersistedDocument(params: {
    projectionName: string;
    documentId: string;
    state: Record<string, unknown>;
    checkpoint: ProjectionCheckpoint;
    mode: ProjectionPersistenceMode;
  }): ProjectedDocument {
    const current = this.documents.get(keyFor(params.projectionName, params.documentId))?.document;
    const metadata = buildProjectionMetadata({
      projectionName: params.projectionName,
      documentId: params.documentId,
      checkpoint: params.checkpoint,
      previous: current?._projection,
      mode: params.mode,
      updatedAt: this.now()
    });
    return withProjectionMetadata(params.state, metadata);
  }

  getDocumentSnapshot(projectionName: string, documentId: string): ProjectedDocument | null {
    const found = this.documents.get(keyFor(projectionName, documentId));
    return found ? deepClone(found.document) : null;
  }

  getStoredDocuments(): Map<string, ProjectedDocument> {
    return new Map(
      [...this.documents.entries()].map(([key, value]) => [key, deepClone(value.document)])
    );
  }

  clear(): void {
    this.documents.clear();
  }

  private withoutProjection(document: ProjectedDocument): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document)) {
      if (key === '_projection') {
        continue;
      }
      result[key] = deepClone(value);
    }
    return result;
  }
}

export async function persistProjectedState(params: {
  persistence: ProjectionPersistenceCapabilities;
  projectionName: string;
  documentId: string;
  nextState: Record<string, unknown>;
  checkpoint: ProjectionCheckpoint;
  operations?: readonly Rfc6902Operation[];
  preferredMode?: ProjectionPersistenceMode;
}): Promise<{ mode: ProjectionPersistenceMode; document: ProjectedDocument }> {
  const resolved: ResolvedProjectionPersistence = resolveProjectionPersistence({
    ...params.persistence,
    preferredMode: params.preferredMode ?? params.persistence.preferredMode
  });

  const current = await resolved.read.loadDocument(params.projectionName, params.documentId);
  const metadata = buildProjectionMetadata({
    projectionName: params.projectionName,
    documentId: params.documentId,
    checkpoint: params.checkpoint,
    previous: current?._projection,
    mode: resolved.mode
  });

  const nextDocument = withProjectionMetadata(params.nextState, metadata);

  if (resolved.mode === 'patch') {
    if (!resolved.patch) {
      throw new Error('Projection runtime persistence configuration error: patch mode resolved without patch capability.');
    }

    await resolved.patch.persistPatch({
      projectionName: params.projectionName,
      documentId: params.documentId,
      expectedVersion: current?._projection.version,
      operations: [...(params.operations ?? topLevelPatchOperations(current ?? {}, params.nextState))],
      metadata
    });

    const stored = await resolved.read.loadDocument(params.projectionName, params.documentId);
    if (!stored) {
      throw new Error('Patch persistence reported success but no document was readable afterwards.');
    }

    return {
      mode: resolved.mode,
      document: stored
    };
  }

  if (!resolved.document) {
    throw new Error('Projection runtime persistence configuration error: document mode resolved without document capability.');
  }

  await resolved.document.persistDocument({
    projectionName: params.projectionName,
    documentId: params.documentId,
    expectedVersion: current?._projection.version,
    document: nextDocument
  });

  const stored = await resolved.read.loadDocument(params.projectionName, params.documentId);
  return {
    mode: resolved.mode,
    document: stored ?? nextDocument
  };
}
