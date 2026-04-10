import { IProjectionStore, Checkpoint } from '@redemeine/projection-runtime-core';
import type { ProjectionAtomicWrite } from '@redemeine/projection-runtime-core';
import type {
  ProjectionStoreWriteFailure,
  ProjectionStoreWritePrecondition,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest,
  ProjectionStoreDocumentWrite,
  ProjectionStoreRfc6902Operation
} from '@redemeine/projection-runtime-core';

interface StoredDocument<TState> {
  state: TState;
  checkpoint: Checkpoint;
  updatedAt: string;
}

class ProjectionStoreAtomicManyError extends Error {
  constructor(readonly failure: ProjectionStoreWriteFailure) {
    super(failure.message);
  }
}

/**
 * In-memory implementation of IProjectionStore.
 *
 * Useful for:
 * - Unit testing projections without database setup
 * - Development and local testing
 * - E2E testing of the projection daemon
 *
 * WARNING: Data is NOT persisted between process restarts.
 */
export class InMemoryProjectionStore<TState = unknown> implements IProjectionStore<TState> {
  private documents = new Map<string, StoredDocument<TState>>();
  private links = new Map<string, string>();
  private dedupe = new Map<string, Checkpoint>();

  private static cloneCheckpoint(checkpoint: Checkpoint): Checkpoint {
    return {
      sequence: checkpoint.sequence,
      ...(checkpoint.timestamp ? { timestamp: checkpoint.timestamp } : {})
    };
  }

  private static chooseHigherWatermark(current: Checkpoint | null, next: Checkpoint): Checkpoint {
    if (!current) {
      return InMemoryProjectionStore.cloneCheckpoint(next);
    }

    if (next.sequence > current.sequence) {
      return InMemoryProjectionStore.cloneCheckpoint(next);
    }

    if (next.sequence === current.sequence && next.timestamp && (!current.timestamp || next.timestamp > current.timestamp)) {
      return InMemoryProjectionStore.cloneCheckpoint(next);
    }

    return current;
  }

  private static decodePathSegment(segment: string): string {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
  }

  private static deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private static pathTokens(path: string): string[] {
    if (path === '') {
      return [];
    }

    const normalized = path.startsWith('/') ? path.slice(1) : path;
    if (!normalized) {
      return [];
    }

    return normalized.split('/').map(InMemoryProjectionStore.decodePathSegment);
  }

  private static isIndexToken(token: string): boolean {
    return /^\d+$/.test(token);
  }

  private static getContainer(root: unknown, tokens: string[]): { parent: any; key: string | undefined } {
    if (tokens.length === 0) {
      return { parent: undefined, key: undefined };
    }

    let current: any = root;
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const token = tokens[index];
      const nextToken = tokens[index + 1];

      if (Array.isArray(current)) {
        const arrayIndex = Number(token);
        if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length) {
          throw new Error(`Invalid RFC6902 path segment "${token}" for array.`);
        }
        if (current[arrayIndex] === undefined || current[arrayIndex] === null) {
          current[arrayIndex] = InMemoryProjectionStore.isIndexToken(nextToken) ? [] : {};
        }
        current = current[arrayIndex];
        continue;
      }

      if (typeof current !== 'object' || current === null) {
        throw new Error(`Cannot traverse RFC6902 path through non-object value at "${token}".`);
      }

      if (!(token in current) || current[token] === undefined || current[token] === null) {
        current[token] = InMemoryProjectionStore.isIndexToken(nextToken) ? [] : {};
      }
      current = current[token];
    }

    return { parent: current, key: tokens[tokens.length - 1] };
  }

  private static removeAtPath(root: any, path: string): unknown {
    const tokens = InMemoryProjectionStore.pathTokens(path);
    if (tokens.length === 0) {
      throw new Error('Removing document root is not supported.');
    }

    const { parent, key } = InMemoryProjectionStore.getContainer(root, tokens);
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

  private static applyRfc6902Operation(target: Record<string, unknown>, operation: ProjectionStoreRfc6902Operation): void {
    const tokens = InMemoryProjectionStore.pathTokens(operation.path);

    if (operation.op === 'remove') {
      InMemoryProjectionStore.removeAtPath(target, operation.path);
      return;
    }

    if (operation.op === 'move') {
      if (!operation.from) {
        throw new Error('RFC6902 move operation requires "from".');
      }

      const moved = InMemoryProjectionStore.removeAtPath(target, operation.from);
      InMemoryProjectionStore.applyRfc6902Operation(target, { op: 'add', path: operation.path, value: moved });
      return;
    }

    if (operation.op === 'copy') {
      if (!operation.from) {
        throw new Error('RFC6902 copy operation requires "from".');
      }

      let source: unknown = target;
      for (const token of InMemoryProjectionStore.pathTokens(operation.from)) {
        source = (source as Record<string, unknown> | undefined)?.[token];
      }

      InMemoryProjectionStore.applyRfc6902Operation(target, {
        op: 'add',
        path: operation.path,
        value: InMemoryProjectionStore.deepClone(source)
      });
      return;
    }

    if (operation.op === 'test') {
      let current: unknown = target;
      for (const token of tokens) {
        current = (current as Record<string, unknown> | undefined)?.[token];
      }

      if (JSON.stringify(operation.value) !== JSON.stringify(current)) {
        throw new Error(`RFC6902 test failed at path "${operation.path}".`);
      }

      return;
    }

    if (tokens.length === 0) {
      throw new Error('Replacing document root is not supported.');
    }

    const { parent, key } = InMemoryProjectionStore.getContainer(target, tokens);

    if (Array.isArray(parent)) {
      if (key === undefined) {
        throw new Error('Missing RFC6902 array key.');
      }

      const index = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) {
        throw new Error(`Invalid RFC6902 array index "${key}".`);
      }

      if (operation.op === 'add') {
        parent.splice(index, 0, InMemoryProjectionStore.deepClone(operation.value));
        return;
      }

      if (index >= parent.length) {
        throw new Error(`Invalid RFC6902 replace index "${key}".`);
      }

      parent[index] = InMemoryProjectionStore.deepClone(operation.value);
      return;
    }

    if (!parent || typeof parent !== 'object' || key === undefined) {
      throw new Error(`Invalid RFC6902 path "${operation.path}".`);
    }

    if (operation.op === 'replace' && !(key in parent)) {
      throw new Error(`RFC6902 replace path not found "${operation.path}".`);
    }

    parent[key] = InMemoryProjectionStore.deepClone(operation.value);
  }

  private static applyPatchDocument<TDoc>(
    existing: TDoc | undefined,
    patch: ReadonlyArray<ProjectionStoreRfc6902Operation>
  ): TDoc {
    const base =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};

    const next = InMemoryProjectionStore.deepClone(base);
    for (const operation of patch) {
      InMemoryProjectionStore.applyRfc6902Operation(next, operation);
    }

    return next as TDoc;
  }

  private static createFailure(
    category: ProjectionStoreWriteFailure['category'],
    code: string,
    message: string
  ): ProjectionStoreWriteFailure {
    return {
      category,
      code,
      message,
      retryable: category !== 'terminal'
    };
  }

  private static createInvalidRequestFailure(message: string): ProjectionStoreWriteFailure {
    return InMemoryProjectionStore.createFailure('terminal', 'invalid-request', message);
  }

  private static createConflictFailure(message: string): ProjectionStoreWriteFailure {
    return InMemoryProjectionStore.createFailure('conflict', 'occ-conflict', message);
  }

  private static matchesCheckpoint(left: Checkpoint, right: Checkpoint): boolean {
    return left.sequence === right.sequence && (left.timestamp ?? null) === (right.timestamp ?? null);
  }

  private static assertPrecondition(
    documentId: string,
    current: StoredDocument<unknown> | undefined,
    precondition?: ProjectionStoreWritePrecondition
  ): void {
    if (!precondition) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(precondition, 'expectedRevision')) {
      const actualRevision = current?.checkpoint.sequence ?? null;
      const expectedRevision = precondition.expectedRevision ?? null;
      if (actualRevision !== expectedRevision) {
        throw new ProjectionStoreAtomicManyError(
          InMemoryProjectionStore.createConflictFailure(
            `OCC precondition failed for document '${documentId}': expectedRevision=${String(expectedRevision)}, actualRevision=${String(actualRevision)}`
          )
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(precondition, 'expectedCheckpoint')) {
      const actualCheckpoint = current?.checkpoint ?? null;
      const expectedCheckpoint = precondition.expectedCheckpoint ?? null;
      const matches = actualCheckpoint !== null && expectedCheckpoint !== null
        ? InMemoryProjectionStore.matchesCheckpoint(actualCheckpoint, expectedCheckpoint)
        : actualCheckpoint === expectedCheckpoint;

      if (!matches) {
        throw new ProjectionStoreAtomicManyError(
          InMemoryProjectionStore.createConflictFailure(
            `OCC precondition failed for document '${documentId}': expectedCheckpoint=${JSON.stringify(expectedCheckpoint)}, actualCheckpoint=${JSON.stringify(actualCheckpoint)}`
          )
        );
      }
    }
  }
  async load(id: string): Promise<TState | null> {
    const doc = this.documents.get(id);
    return doc ? doc.state : null;
  }

  async save(id: string, state: TState, cursor: Checkpoint): Promise<void> {
    // Atomic save - both state and checkpoint are updated together
    this.documents.set(id, {
      state,
      checkpoint: cursor,
      updatedAt: new Date().toISOString()
    });
  }

  async commitAtomic(write: ProjectionAtomicWrite<TState>): Promise<void> {
    for (const document of write.documents) {
      this.documents.set(document.documentId, {
        state: document.state,
        checkpoint: document.checkpoint,
        updatedAt: new Date().toISOString()
      });
    }

    for (const link of write.links) {
      const key = `${link.aggregateType}:${link.aggregateId}`;

      if (link.op === 'remove') {
        const existing = this.links.get(key);
        if (existing === link.targetDocId) {
          this.links.delete(key);
        }
        continue;
      }

      if (!this.links.has(key)) {
        this.links.set(key, link.targetDocId);
      }
    }

    this.documents.set(write.cursorKey, {
      state: {} as TState,
      checkpoint: write.cursor,
      updatedAt: new Date().toISOString()
    });

    for (const dedupe of write.dedupe.upserts) {
      this.dedupe.set(dedupe.key, dedupe.checkpoint);
    }
  }

  async commitAtomicMany(
    request: ProjectionStoreCommitAtomicManyRequest<TState>
  ): Promise<ProjectionStoreAtomicManyResult> {
    if (request.mode !== 'atomic-all') {
      const failure = InMemoryProjectionStore.createInvalidRequestFailure(`unsupported mode: ${request.mode}`);
      return {
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex: 0,
        failure,
        reason: failure.message,
        committedCount: 0
      };
    }

    if (request.writes.length === 0) {
      const failure = InMemoryProjectionStore.createInvalidRequestFailure('no writes');
      return {
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex: 0,
        failure,
        reason: failure.message,
        committedCount: 0
      };
    }

    const stagedDocuments = new Map(this.documents);
    const stagedDedupe = new Map(this.dedupe);
    const byLaneWatermark: Record<string, Checkpoint> = {};
    let highestWatermark: Checkpoint | null = null;

    const seenDocumentIds = new Set<string>();
    for (let index = 0; index < request.writes.length; index += 1) {
      const write = request.writes[index];
      for (const document of write.documents) {
        if (seenDocumentIds.has(document.documentId)) {
          const failure = InMemoryProjectionStore.createInvalidRequestFailure(
            `duplicate document write in atomic-all batch: documentId='${document.documentId}'`
          );
          return {
            status: 'rejected',
            highestWatermark: null,
            failedAtIndex: index,
            failure,
            reason: failure.message,
            committedCount: 0
          };
        }

        seenDocumentIds.add(document.documentId);
      }
    }

    const applyDocumentWrite = (write: ProjectionStoreDocumentWrite<TState>): void => {
      if (write.mode === 'full') {
        stagedDocuments.set(write.documentId, {
          state: write.fullDocument,
          checkpoint: InMemoryProjectionStore.cloneCheckpoint(write.checkpoint),
          updatedAt: new Date().toISOString()
        });
        return;
      }

      const current = stagedDocuments.get(write.documentId);
      stagedDocuments.set(write.documentId, {
        state: InMemoryProjectionStore.applyPatchDocument(current?.state, write.patch),
        checkpoint: InMemoryProjectionStore.cloneCheckpoint(write.checkpoint),
        updatedAt: new Date().toISOString()
      });
    };

    for (let index = 0; index < request.writes.length; index += 1) {
      const write = request.writes[index];
      let laneWatermark: Checkpoint | null = null;

      try {
        for (const document of write.documents) {
          const current = stagedDocuments.get(document.documentId);
          InMemoryProjectionStore.assertPrecondition(document.documentId, current, document.precondition);
          applyDocumentWrite(document);
          laneWatermark = InMemoryProjectionStore.chooseHigherWatermark(laneWatermark, document.checkpoint);
          highestWatermark = InMemoryProjectionStore.chooseHigherWatermark(highestWatermark, document.checkpoint);
        }

        for (const dedupe of write.dedupe.upserts) {
          stagedDedupe.set(dedupe.key, InMemoryProjectionStore.cloneCheckpoint(dedupe.checkpoint));
          laneWatermark = InMemoryProjectionStore.chooseHigherWatermark(laneWatermark, dedupe.checkpoint);
          highestWatermark = InMemoryProjectionStore.chooseHigherWatermark(highestWatermark, dedupe.checkpoint);
        }
      } catch (error) {
        const failure = error instanceof ProjectionStoreAtomicManyError
          ? error.failure
          : InMemoryProjectionStore.createFailure(
            'transient',
            'write-failed',
            error instanceof Error ? error.message : 'atomicMany write failed'
          );

        return {
          status: 'rejected',
          highestWatermark: null,
          failedAtIndex: index,
          failure,
          reason: failure.message,
          committedCount: 0
        };
      }

      if (laneWatermark) {
        byLaneWatermark[write.routingKeySource] = laneWatermark;
      }
    }

    this.documents = stagedDocuments;
    this.dedupe = stagedDedupe;

    return {
      status: 'committed',
      highestWatermark: highestWatermark ?? { sequence: 0 },
      byLaneWatermark,
      committedCount: request.writes.length
    };
  }

  async resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> {
    return this.links.get(`${aggregateType}:${aggregateId}`) ?? null;
  }

  async exists(id: string): Promise<boolean> {
    return this.documents.has(id);
  }

  async delete(id: string): Promise<void> {
    this.documents.delete(id);
  }

  async getCheckpoint(id: string): Promise<Checkpoint | null> {
    const doc = this.documents.get(id);
    return doc ? doc.checkpoint : null;
  }

  async getDedupeCheckpoint(key: string): Promise<Checkpoint | null> {
    return this.dedupe.get(key) ?? null;
  }

  // Helper methods for testing
  clear(): void {
    this.documents.clear();
    this.links.clear();
    this.dedupe.clear();
  }

  getAll(): Map<string, StoredDocument<TState>> {
    return new Map(this.documents);
  }
}
