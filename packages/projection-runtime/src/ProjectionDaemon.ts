import { ProjectionRuntimeProcessor } from './ProjectionRuntimeProcessor';
import { InMemoryCursorStoreAdapter } from './cursor/InMemoryCursorStoreAdapter';
import type { CommitFeedBatch, ProjectionCheckpoint, ProjectionCommit } from './contracts/commitFeed';
import type { CommitFeedContract } from './contracts/commitFeed';
import { InMemoryProjectionStore, type IProjectionStore } from './InMemoryProjectionStore';
import type { EventBatch, IEventSubscription } from './IEventSubscription';
import type { LinkStoreContract, ProjectionLink, ProjectionLinkKey } from './contracts/linkStore';
import type { ProjectedDocument } from './contracts/persistence';
import type { ProjectionMetadataEnvelope } from './contracts/persistence';

export interface ProjectionDaemonOptions<TState extends Record<string, unknown> = Record<string, unknown>> {
  projection: {
    name: string;
    fromStream: {
      aggregate: { aggregateType: string };
      handlers: Record<string, (state: TState, event: ProjectionCommit, context: unknown) => void>;
    };
    joinStreams?: Array<{
      aggregate: { aggregateType: string };
      handlers: Record<string, (state: TState, event: ProjectionCommit, context: unknown) => void>;
    }>;
    initialState: (documentId: string) => TState;
    identity: (event: ProjectionCommit) => string | readonly string[];
  };
  subscription: IEventSubscription;
  store: IProjectionStore<TState>;
  batchSize?: number;
}

export interface BatchStats {
  eventsProcessed: number;
  documentsUpdated: number;
  duration: number;
}

class EventSubscriptionCommitFeedAdapter implements CommitFeedContract {
  constructor(private readonly subscription: IEventSubscription) {}

  async readAfter(checkpoint: ProjectionCheckpoint, limit: number): Promise<CommitFeedBatch> {
    const batch = await this.subscription.poll(checkpoint, limit);
    return {
      commits: batch.events,
      nextCheckpoint: batch.nextCursor
    };
  }
}

class ProjectionStoreLinkStoreAdapter implements LinkStoreContract {
  private readonly links = new Map<string, Set<string>>();

  async add(link: ProjectionLink): Promise<void> {
    const key = this.makeKey(link.key);
    const targets = this.links.get(key) ?? new Set<string>();
    targets.add(link.targetDocumentId);
    this.links.set(key, targets);
  }

  async removeForTarget(targetDocumentId: string): Promise<void> {
    for (const targets of this.links.values()) {
      targets.delete(targetDocumentId);
    }
  }

  async resolveTargets(key: ProjectionLinkKey): Promise<string[]> {
    return Array.from(this.links.get(this.makeKey(key)) ?? []);
  }

  private makeKey(key: ProjectionLinkKey): string {
    return `${key.aggregateType}:${key.aggregateId}`;
  }
}

class ProjectionStorePersistenceAdapter<TState extends Record<string, unknown>> {
  constructor(private readonly store: IProjectionStore<TState>) {}

  private readonly metadataByDocumentId = new Map<string, ProjectedDocument['_projection']>();

  async loadDocument(_projectionName: string, documentId: string): Promise<ProjectedDocument<Record<string, unknown>> | null> {
    const loaded = await this.store.load(documentId);
    const metadata = this.metadataByDocumentId.get(documentId);

    if (!loaded || !metadata) {
      return null;
    }

    return {
      ...(loaded as Record<string, unknown>),
      _projection: {
        ...metadata
      }
    };
  }

  async persistDocument(change: {
    projectionName: string;
    documentId: string;
    expectedVersion?: number;
    document: Record<string, unknown> & { _projection: ProjectionMetadataEnvelope };
  }): Promise<void> {
    const { _projection, ...state } = change.document;
    this.metadataByDocumentId.set(change.documentId, _projection);
    await this.store.save(change.documentId, state as TState, _projection.lastCheckpoint);
  }
}

export class ProjectionDaemon<TState extends Record<string, unknown> = Record<string, unknown>> {
  private readonly processor: ProjectionRuntimeProcessor<TState>;

  private readonly cursorStore: InMemoryCursorStoreAdapter;

  constructor(private readonly options: ProjectionDaemonOptions<TState>) {
    this.cursorStore = new InMemoryCursorStoreAdapter();

    this.processor = new ProjectionRuntimeProcessor<TState>({
      projection: options.projection as any,
      commitFeed: new EventSubscriptionCommitFeedAdapter(options.subscription),
      cursorStore: this.cursorStore,
      linkStore: new ProjectionStoreLinkStoreAdapter(),
      persistence: new ProjectionStorePersistenceAdapter(options.store) as any,
      batchSize: options.batchSize ?? 100,
      persistenceMode: 'document'
    });
  }

  async processBatch(): Promise<BatchStats> {
    const startedAt = Date.now();
    const stats = await this.processor.processNextBatch();

    const cursor = await this.cursorStore.load(this.options.projection.name);
    if (cursor) {
      await this.options.store.save(`__cursor__${this.options.projection.name}`, {} as TState, cursor.checkpoint);
    }

    return {
      eventsProcessed: stats.commitsApplied,
      documentsUpdated: stats.documentsPersisted,
      duration: Date.now() - startedAt
    };
  }
}

export { InMemoryProjectionStore };
export type { IProjectionStore, IEventSubscription, EventBatch, ProjectionCommit as ProjectionEvent };
