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

  async getCheckpoint(key: string): Promise<Checkpoint | null> {
    const row = await this.options.collection.findOne({ _id: key });
    return row ? row.checkpoint : null;
  }
}
