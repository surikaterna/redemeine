import type { CommitFeedContract, ProjectionCheckpoint, ProjectionCommit } from './contracts/commitFeed';
import type { CursorStoreContract } from './contracts/cursorStore';
import type { LinkStoreContract } from './contracts/linkStore';
import type {
  DocumentProjectionPersistenceContract,
  PersistProjectionDocument,
  ProjectedDocument,
  ProjectionReadContract
} from './contracts/persistence';
import type { VersionNotifierContract } from './contracts/versionNotifier';

type PlainObject = Record<string, unknown>;

type RuntimeProjectionContext = {
  subscribeTo: (aggregate: { __aggregateType: string }, aggregateId: string) => void;
  getSubscriptions: () => Array<{ aggregate: { __aggregateType: string }; aggregateId: string }>;
};

type RuntimeProjectionHandler<TState extends PlainObject> = (
  state: TState,
  event: ProjectionCommit,
  context: RuntimeProjectionContext
) => void;

type RuntimeProjectionDefinition<TState extends PlainObject> = {
  name: string;
  fromStream: {
    aggregate: { __aggregateType: string };
    handlers: Record<string, RuntimeProjectionHandler<TState>>;
  };
  joinStreams?: Array<{
    aggregate: { __aggregateType: string };
    handlers: Record<string, RuntimeProjectionHandler<TState>>;
  }>;
  initialState: (documentId: string) => TState;
  identity: (event: ProjectionCommit) => string | readonly string[];
};

type ProjectionPersistenceContract<TState extends PlainObject> = ProjectionReadContract<TState> &
  DocumentProjectionPersistenceContract;

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
  batchSize?: number;
  onBatch?: (stats: ProjectionRuntimeBatchStats) => void;
}

interface PendingDocument<TState extends PlainObject> {
  documentId: string;
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
              aggregateType: subscription.aggregate.__aggregateType,
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
      const metadata = {
        projectionName: this.options.projection.name,
        documentId: pending.documentId,
        version: pending.baseVersion + pending.appliedCommits,
        lastCheckpoint: pending.lastCheckpoint,
        updatedAt: pending.lastCheckpoint.timestamp ?? new Date().toISOString(),
        persistenceMode: 'document' as const
      };

      const projectedDocument: ProjectedDocument<TState> = {
        ...(pending.state as TState),
        _projection: metadata
      };

      const change: PersistProjectionDocument = {
        projectionName: this.options.projection.name,
        documentId: pending.documentId,
        expectedVersion: pending.baseVersion > 0 ? pending.baseVersion : undefined,
        document: projectedDocument
      };

      await this.options.persistence.persistDocument(change);

      if (this.options.versionNotifier) {
        await this.options.versionNotifier.notifyVersionAvailable({
          projectionName: this.options.projection.name,
          documentId: pending.documentId,
          version: metadata.version
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

  private resolveHandler(commit: ProjectionCommit): RuntimeProjectionHandler<TState> | null {
    const { projection } = this.options;
    const streamHandlers =
      commit.aggregateType === projection.fromStream.aggregate.__aggregateType
        ? projection.fromStream.handlers
        : projection.joinStreams?.find((joinStream) => joinStream.aggregate.__aggregateType === commit.aggregateType)?.handlers;

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

    if (commit.aggregateType === projection.fromStream.aggregate.__aggregateType) {
      const identity = projection.identity(commit);
      const fanout = Array.isArray(identity) ? identity : [identity];
      return this.uniqueDocumentIds(fanout);
    }

    const joinStream = projection.joinStreams?.find((stream) => stream.aggregate.__aggregateType === commit.aggregateType);
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
    const subscriptions: Array<{ aggregate: { __aggregateType: string }; aggregateId: string }> = [];

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
