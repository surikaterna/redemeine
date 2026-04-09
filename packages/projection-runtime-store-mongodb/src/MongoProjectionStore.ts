import type { Checkpoint, IProjectionStore } from './contracts';
import type { MongoProjectionStoreOptions, ProjectionDocumentRecord } from './types';

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
}
