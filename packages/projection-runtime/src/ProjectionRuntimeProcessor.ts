import type { CommitFeedContract, ProjectionCheckpoint, ProjectionCommit } from './contracts/commitFeed';
import type { CursorStoreContract } from './contracts/cursorStore';
import type { LinkStoreContract } from './contracts/linkStore';
import type {
  DocumentProjectionPersistenceContract,
  PatchProjectionPersistenceContract,
  ProjectedDocument,
  ProjectionReadContract,
  Rfc6902Operation
} from './contracts/persistence';
import type { VersionNotifierContract } from './contracts/versionNotifier';
import { persistProjectedState } from './persistence/InMemoryProjectionPersistenceAdapter';
import type { ProjectionPersistenceCapabilities, ProjectionPersistenceMode } from './persistence/modeSelection';

type PlainObject = Record<string, unknown>;

type RuntimeProjectionContext = {
  subscribeTo: (aggregate: { aggregateType: string }, aggregateId: string) => void;
  getSubscriptions: () => Array<{ aggregate: { aggregateType: string }; aggregateId: string }>;
};

type RuntimeProjectionHandler<TState extends PlainObject> = (
  state: TState,
  event: ProjectionCommit,
  context: RuntimeProjectionContext
) => void;

type RuntimeProjectionDefinition<TState extends PlainObject> = {
  name: string;
  fromStream: {
    aggregate: { aggregateType: string };
    handlers: Record<string, RuntimeProjectionHandler<TState>>;
  };
  joinStreams?: Array<{
    aggregate: { aggregateType: string };
    handlers: Record<string, RuntimeProjectionHandler<TState>>;
  }>;
  initialState: (documentId: string) => TState;
  identity: (event: ProjectionCommit) => string | readonly string[];
};

type ProjectionPersistenceContract<TState extends PlainObject> = ProjectionReadContract<TState> &
  Partial<ProjectionPersistenceCapabilities<TState>> &
  Partial<PatchProjectionPersistenceContract> &
  Partial<DocumentProjectionPersistenceContract>;

export interface ProjectionRuntimeBatchStats {
  commitsRead: number;
  commitsApplied: number;
  documentsPersisted: number;
  linksCreated: number;
  durationMs: number;
  cursorAdvanced: boolean;
}

export interface ProjectionRuntimeProcessorOptions<TState extends PlainObject> {
  projection: RuntimeProjectionDefinition<TState>;
  commitFeed: CommitFeedContract;
  cursorStore: CursorStoreContract;
  linkStore: LinkStoreContract;
  persistence: ProjectionPersistenceContract<TState>;
  versionNotifier?: VersionNotifierContract;
  persistenceMode?: ProjectionPersistenceMode;
  batchSize?: number;
  onBatch?: (stats: ProjectionRuntimeBatchStats) => void;
}

const DEFAULT_PERSISTENCE_MODE: ProjectionPersistenceMode = 'document';

interface PendingDocument<TState extends PlainObject> {
  documentId: string;
  previousState: TState;
  state: TState;
  baseVersion: number;
  appliedCommits: number;
  lastCheckpoint: ProjectionCheckpoint;
}

export class ProjectionRuntimeProcessor<TState extends PlainObject> {
  constructor(private readonly options: ProjectionRuntimeProcessorOptions<TState>) {}

  async processNextBatch(): Promise<ProjectionRuntimeBatchStats> {
    const startedAt = Date.now();
    const currentCursor = await this.loadCursor();
    const batch = await this.options.commitFeed.readAfter(currentCursor, this.options.batchSize ?? 100);

    if (batch.commits.length === 0) {
      return this.completeBatch({
        commitsRead: 0,
        commitsApplied: 0,
        documentsPersisted: 0,
        linksCreated: 0,
        durationMs: Date.now() - startedAt,
        cursorAdvanced: false
      });
    }

    const pendingDocuments = new Map<string, PendingDocument<TState>>();
    let commitsApplied = 0;
    let linksCreated = 0;

    for (const commit of batch.commits) {
      const handler = this.resolveHandler(commit);
      if (!handler) {
        continue;
      }

      const targetDocumentIds = await this.resolveTargetDocumentIds(commit);
      if (targetDocumentIds.length === 0) {
        continue;
      }

      commitsApplied += 1;

      for (const documentId of targetDocumentIds) {
        const pending = await this.getOrCreatePendingDocument(documentId, pendingDocuments);
        const context = this.createContext();

        handler(pending.state as never, commit as never, context);

        const subscriptions = context.getSubscriptions();
        for (const subscription of subscriptions) {
          await this.options.linkStore.add({
            key: {
              aggregateType: subscription.aggregate.aggregateType,
              aggregateId: subscription.aggregateId
            },
            targetDocumentId: documentId
          });
          linksCreated += 1;
        }

        pending.appliedCommits += 1;
        pending.lastCheckpoint = {
          sequence: commit.sequence,
          timestamp: commit.timestamp
        };
      }
    }

    const documentsToPersist = Array.from(pendingDocuments.values()).filter((pending) => pending.appliedCommits > 0);

    for (const pending of documentsToPersist) {
      const persisted = await persistProjectedState({
        persistence: this.resolvePersistenceCapabilities(),
        projectionName: this.options.projection.name,
        documentId: pending.documentId,
        nextState: pending.state,
        checkpoint: pending.lastCheckpoint,
        preferredMode: this.options.persistenceMode ?? DEFAULT_PERSISTENCE_MODE,
        operations: this.buildPatchOperations(pending)
      });

      if (this.options.versionNotifier) {
        await this.options.versionNotifier.notifyVersionAvailable({
          projectionName: this.options.projection.name,
          documentId: pending.documentId,
          version: persisted.document._projection.version
        });
      }
    }

    await this.options.cursorStore.save({
      projectionName: this.options.projection.name,
      checkpoint: batch.nextCheckpoint
    });

    return this.completeBatch({
      commitsRead: batch.commits.length,
      commitsApplied,
      documentsPersisted: documentsToPersist.length,
      linksCreated,
      durationMs: Date.now() - startedAt,
      cursorAdvanced: true
    });
  }

  private completeBatch(stats: ProjectionRuntimeBatchStats): ProjectionRuntimeBatchStats {
    if (this.options.onBatch) {
      this.options.onBatch(stats);
    }

    return stats;
  }

  private async loadCursor(): Promise<ProjectionCheckpoint> {
    const cursor = await this.options.cursorStore.load(this.options.projection.name);
    return cursor?.checkpoint ?? { sequence: 0 };
  }

  private async getOrCreatePendingDocument(
    documentId: string,
    pendingDocuments: Map<string, PendingDocument<TState>>
  ): Promise<PendingDocument<TState>> {
    const existingPending = pendingDocuments.get(documentId);
    if (existingPending) {
      return existingPending;
    }

    const storedDocument = await this.options.persistence.loadDocument(this.options.projection.name, documentId);
    const currentState = storedDocument
      ? this.stripProjectionMetadata(storedDocument)
      : this.options.projection.initialState(documentId);

    const pending: PendingDocument<TState> = {
      documentId,
      previousState: this.deepCloneState(currentState),
      state: currentState,
      baseVersion: storedDocument?._projection.version ?? 0,
      appliedCommits: 0,
      lastCheckpoint: storedDocument?._projection.lastCheckpoint ?? { sequence: 0 }
    };

    pendingDocuments.set(documentId, pending);
    return pending;
  }

  private stripProjectionMetadata(document: ProjectedDocument<TState>): TState {
    const { _projection: _, ...state } = document;
    return state as unknown as TState;
  }

  private deepCloneState(state: TState): TState {
    return JSON.parse(JSON.stringify(state)) as TState;
  }

  private resolvePersistenceCapabilities(): ProjectionPersistenceCapabilities<TState> {
    const persistence = this.options.persistence;

    return {
      preferredMode: persistence.preferredMode,
      read: persistence,
      patch:
        persistence.patch ??
        (typeof persistence.persistPatch === 'function'
          ? {
              persistPatch: persistence.persistPatch.bind(persistence)
            }
          : undefined),
      document:
        persistence.document ??
        (typeof persistence.persistDocument === 'function'
          ? {
              persistDocument: persistence.persistDocument.bind(persistence)
            }
          : undefined)
    };
  }

  private buildPatchOperations(pending: PendingDocument<TState>): Rfc6902Operation[] {
    const operations: Rfc6902Operation[] = [];
    const previousState = pending.previousState as Record<string, unknown>;
    const nextState = pending.state as Record<string, unknown>;

    if (pending.baseVersion === 0) {
      for (const [key, value] of Object.entries(nextState)) {
        operations.push({
          op: 'add',
          path: `/${this.escapePathSegment(key)}`,
          value
        });
      }
      return operations;
    }

    for (const key of Object.keys(previousState)) {
      if (!(key in nextState)) {
        operations.push({
          op: 'remove',
          path: `/${this.escapePathSegment(key)}`
        });
      }
    }

    for (const [key, value] of Object.entries(nextState)) {
      const operation: Rfc6902Operation = {
        op: key in previousState ? 'replace' : 'add',
        path: `/${this.escapePathSegment(key)}`,
        value
      };
      operations.push(operation);
    }

    return operations;
  }

  private escapePathSegment(segment: string): string {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
  }

  private resolveHandler(commit: ProjectionCommit): RuntimeProjectionHandler<TState> | null {
    const { projection } = this.options;
    const streamHandlers =
      commit.aggregateType === projection.fromStream.aggregate.aggregateType
        ? projection.fromStream.handlers
        : projection.joinStreams?.find((joinStream) => joinStream.aggregate.aggregateType === commit.aggregateType)?.handlers;

    if (!streamHandlers) {
      return null;
    }

    const candidateKeys = this.getHandlerCandidateKeys(commit);
    for (const key of candidateKeys) {
      const handler = streamHandlers[key as keyof typeof streamHandlers];
      if (handler) {
        return handler;
      }
    }

    return null;
  }

  private async resolveTargetDocumentIds(commit: ProjectionCommit): Promise<string[]> {
    const { projection } = this.options;

    if (commit.aggregateType === projection.fromStream.aggregate.aggregateType) {
      const identity = projection.identity(commit);
      const fanout = Array.isArray(identity) ? identity : [identity];
      return this.uniqueDocumentIds(fanout);
    }

    const joinStream = projection.joinStreams?.find((stream) => stream.aggregate.aggregateType === commit.aggregateType);
    if (!joinStream) {
      return [];
    }

    const targets = await this.options.linkStore.resolveTargets({
      aggregateType: commit.aggregateType,
      aggregateId: commit.aggregateId
    });

    return this.uniqueDocumentIds(targets);
  }

  private uniqueDocumentIds(candidates: readonly string[]): string[] {
    return Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));
  }

  private createContext(): RuntimeProjectionContext {
    const subscriptions: Array<{ aggregate: { aggregateType: string }; aggregateId: string }> = [];

    return {
      subscribeTo(aggregate, aggregateId) {
        subscriptions.push({ aggregate, aggregateId });
      },
      getSubscriptions() {
        return [...subscriptions];
      }
    };
  }

  private getHandlerCandidateKeys(commit: ProjectionCommit): string[] {
    const eventType = commit.type;
    const keys = new Set<string>([eventType]);
    const aggregatePrefix = `${commit.aggregateType}.`;

    if (eventType.startsWith(aggregatePrefix)) {
      keys.add(eventType.slice(aggregatePrefix.length));
    }

    if (eventType.endsWith('.event')) {
      const withoutSuffix = eventType.slice(0, -'.event'.length);
      keys.add(withoutSuffix);
      if (withoutSuffix.startsWith(aggregatePrefix)) {
        keys.add(withoutSuffix.slice(aggregatePrefix.length));
      }
    }

    return Array.from(keys);
  }
}
