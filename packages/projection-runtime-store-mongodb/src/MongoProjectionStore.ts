import type {
  Checkpoint,
  IProjectionStore,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest,
  ProjectionStoreDocumentWrite
} from './contracts';
import type {
  MongoProjectionStoreOptions,
  ProjectionDedupeRecord,
  ProjectionDocumentRecord
} from './types';

const defaultNow = (): string => new Date().toISOString();

/**
 * Mongo-backed projection store adapter.
 *
 * This class depends only on a minimal collection-like surface so tests can
 * use in-memory mocks without requiring a live MongoDB server.
 */
export class MongoProjectionStore<TState = unknown> implements IProjectionStore<TState> {
  private readonly now: () => string;

  constructor(private readonly options: MongoProjectionStoreOptions<TState>) {
    this.now = options.now ?? defaultNow;
  }

  async load(documentId: string): Promise<TState | null> {
    const row = await this.options.collection.findOne({ _id: documentId });
    return row ? row.state : null;
  }

  async save(documentId: string, state: TState, checkpoint: Checkpoint): Promise<void> {
    const document: ProjectionDocumentRecord<TState> = {
      _id: documentId,
      state,
      checkpoint,
      updatedAt: this.now()
    };

    await this.options.collection.updateOne(
      { _id: documentId },
      {
        $set: {
          state: document.state,
          checkpoint: document.checkpoint,
          updatedAt: document.updatedAt
        }
      },
      { upsert: true }
    );
  }

  async delete(documentId: string): Promise<void> {
    await this.options.collection.deleteOne({ _id: documentId });
  }

  async commitAtomic(write: {
    documents: Array<{ documentId: string; state: TState; checkpoint: Checkpoint }>;
    links: Array<{ aggregateType: string; aggregateId: string; targetDocId: string }>;
    cursorKey: string;
    cursor: Checkpoint;
    dedupe: { upserts: Array<{ key: string; checkpoint: Checkpoint }> };
  }): Promise<void> {
    for (const document of write.documents) {
      await this.save(document.documentId, document.state, document.checkpoint);
    }

    for (const link of write.links) {
      const _id = `${link.aggregateType}:${link.aggregateId}`;
      await this.options.linkCollection.updateOne(
        { _id },
        {
          $setOnInsert: {
            aggregateType: link.aggregateType,
            aggregateId: link.aggregateId,
            targetDocId: link.targetDocId,
            createdAt: this.now()
          }
        },
        { upsert: true }
      );
    }

    await this.save(write.cursorKey, {} as TState, write.cursor);

    for (const dedupe of write.dedupe.upserts) {
      await this.options.dedupeCollection.updateOne(
        { _id: dedupe.key },
        {
          $set: {
            checkpoint: dedupe.checkpoint,
            updatedAt: this.now()
          }
        },
        { upsert: true }
      );
    }
  }

  async commitAtomicMany(
    request: ProjectionStoreCommitAtomicManyRequest<TState>
  ): Promise<ProjectionStoreAtomicManyResult> {
    if (request.mode !== 'atomic-all') {
      return {
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex: 0,
        reason: `unsupported mode: ${request.mode}`,
        committedCount: 0
      };
    }

    if (request.writes.length === 0) {
      return {
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex: 0,
        reason: 'no writes',
        committedCount: 0
      };
    }

    const byLaneWatermark: Record<string, Checkpoint> = {};
    let highestWatermark: Checkpoint | null = null;
    let failedAtIndex = 0;
    const originalDocuments = new Map<string, ProjectionDocumentRecord<TState> | null>();
    const originalDedupe = new Map<string, ProjectionDedupeRecord | null>();

    const runInTransaction = this.options.executeInTransaction ?? (async <T>(work: () => Promise<T>): Promise<T> => work());

    try {
      await runInTransaction(async () => {
        for (let index = 0; index < request.writes.length; index += 1) {
          failedAtIndex = index;
          const write = request.writes[index];
          let laneWatermark: Checkpoint | null = null;

          for (const document of write.documents) {
            if (!originalDocuments.has(document.documentId)) {
              const existing = await this.options.collection.findOne({ _id: document.documentId });
              originalDocuments.set(document.documentId, existing ? { ...existing } : null);
            }

            await this.persistDocumentWrite(document);
            laneWatermark = this.chooseHigherWatermark(laneWatermark, document.checkpoint);
            highestWatermark = this.chooseHigherWatermark(highestWatermark, document.checkpoint);
          }

          for (const dedupe of write.dedupe.upserts) {
            if (!originalDedupe.has(dedupe.key)) {
              const existing = await this.options.dedupeCollection.findOne({ _id: dedupe.key });
              originalDedupe.set(dedupe.key, existing ? { ...existing } : null);
            }

            await this.options.dedupeCollection.updateOne(
              { _id: dedupe.key },
              {
                $set: {
                  checkpoint: dedupe.checkpoint,
                  updatedAt: this.now()
                }
              },
              { upsert: true }
            );

            laneWatermark = this.chooseHigherWatermark(laneWatermark, dedupe.checkpoint);
            highestWatermark = this.chooseHigherWatermark(highestWatermark, dedupe.checkpoint);
          }

          if (laneWatermark) {
            byLaneWatermark[write.routingKeySource] = laneWatermark;
          }
        }
      });
    } catch (error) {
      await this.rollbackAtomicMany(originalDocuments, originalDedupe);
      return {
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex,
        reason: error instanceof Error ? error.message : 'atomicMany write failed',
        committedCount: 0
      };
    }

    return {
      status: 'committed',
      highestWatermark: highestWatermark ?? { sequence: 0 },
      byLaneWatermark,
      committedCount: request.writes.length
    };
  }

  async resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> {
    const row = await this.options.linkCollection.findOne({ _id: `${aggregateType}:${aggregateId}` });
    return row ? row.targetDocId : null;
  }

  async getCheckpoint(key: string): Promise<Checkpoint | null> {
    const row = await this.options.collection.findOne({ _id: key });
    return row ? row.checkpoint : null;
  }

  async getDedupeCheckpoint(key: string): Promise<Checkpoint | null> {
    const row = await this.options.dedupeCollection.findOne({ _id: key });
    return row ? row.checkpoint : null;
  }

  private async persistDocumentWrite(write: ProjectionStoreDocumentWrite<TState>): Promise<void> {
    if (write.mode === 'full') {
      await this.save(write.documentId, write.fullDocument, write.checkpoint);
      return;
    }

    const current = await this.options.collection.findOne({ _id: write.documentId });
    const currentState = current?.state;
    const base =
      currentState && typeof currentState === 'object' && !Array.isArray(currentState)
        ? (currentState as Record<string, unknown>)
        : {};

    const nextState = {
      ...base,
      ...write.patch
    } as TState;

    await this.save(write.documentId, nextState, write.checkpoint);
  }

  private chooseHigherWatermark(current: Checkpoint | null, next: Checkpoint): Checkpoint {
    if (!current) {
      return this.cloneCheckpoint(next);
    }

    if (next.sequence > current.sequence) {
      return this.cloneCheckpoint(next);
    }

    if (next.sequence === current.sequence && next.timestamp && (!current.timestamp || next.timestamp > current.timestamp)) {
      return this.cloneCheckpoint(next);
    }

    return current;
  }

  private cloneCheckpoint(checkpoint: Checkpoint): Checkpoint {
    return {
      sequence: checkpoint.sequence,
      ...(checkpoint.timestamp ? { timestamp: checkpoint.timestamp } : {})
    };
  }

  private async rollbackAtomicMany(
    originalDocuments: Map<string, ProjectionDocumentRecord<TState> | null>,
    originalDedupe: Map<string, ProjectionDedupeRecord | null>
  ): Promise<void> {
    for (const [documentId, snapshot] of originalDocuments.entries()) {
      if (!snapshot) {
        await this.options.collection.deleteOne({ _id: documentId });
        continue;
      }

      await this.options.collection.updateOne(
        { _id: documentId },
        {
          $set: {
            state: snapshot.state,
            checkpoint: snapshot.checkpoint,
            updatedAt: snapshot.updatedAt
          }
        },
        { upsert: true }
      );
    }

    for (const [dedupeKey, snapshot] of originalDedupe.entries()) {
      if (!snapshot) {
        await this.options.dedupeCollection.deleteOne({ _id: dedupeKey });
        continue;
      }

      await this.options.dedupeCollection.updateOne(
        { _id: dedupeKey },
        {
          $set: {
            checkpoint: snapshot.checkpoint,
            updatedAt: snapshot.updatedAt
          }
        },
        { upsert: true }
      );
    }
  }
}
