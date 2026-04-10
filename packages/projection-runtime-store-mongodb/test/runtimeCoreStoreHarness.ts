import type { Checkpoint, IProjectionStore, ProjectionAtomicWrite } from '../../projection-runtime-core/src';
import { MongoProjectionStore } from '../src';
import type { InMemoryMongoCollection } from './mocks';
import {
  createFakeMongoClient,
  createProjectionDedupeCollection,
  createProjectionDocumentCollection,
  createProjectionLinkCollection
} from './mocks';

type LinkRecord = {
  _id: string;
  aggregateType: string;
  aggregateId: string;
  targetDocId: string;
  createdAt: string;
};

class RuntimeCoreMongoProjectionStore<TState> implements IProjectionStore<TState> {
  constructor(
    private readonly store: MongoProjectionStore<TState>,
    private readonly linkCollection: InMemoryMongoCollection<LinkRecord>
  ) {}

  async load(documentId: string): Promise<TState | null> {
    return this.store.load(documentId);
  }

  async save(documentId: string, state: TState, checkpoint: Checkpoint): Promise<void> {
    await this.store.save(documentId, state, checkpoint);
  }

  async commitAtomic(write: ProjectionAtomicWrite<TState>): Promise<void> {
    for (const link of write.links) {
      if (link.op !== 'remove') {
        continue;
      }

      const key = `${link.aggregateType}:${link.aggregateId}`;
      const existing = await this.linkCollection.findOne({ _id: key });
      if (existing?.targetDocId === link.targetDocId) {
        await this.linkCollection.deleteOne({ _id: key });
      }
    }

    await this.store.commitAtomic({
      ...write,
      links: write.links
        .filter((link) => link.op === 'add')
        .map((link) => ({
          aggregateType: link.aggregateType,
          aggregateId: link.aggregateId,
          targetDocId: link.targetDocId
        }))
    });
  }

  async resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> {
    return this.store.resolveTarget(aggregateType, aggregateId);
  }

  async getCheckpoint(key: string): Promise<Checkpoint | null> {
    return this.store.getCheckpoint?.(key) ?? null;
  }

  async getDedupeCheckpoint(key: string): Promise<Checkpoint | null> {
    return this.store.getDedupeCheckpoint(key);
  }

  async delete(documentId: string): Promise<void> {
    await this.store.delete?.(documentId);
  }
}

export const createMongoRuntimeCoreStore = <TState = unknown>() => {
  const collection = createProjectionDocumentCollection<TState>();
  const linkCollection = createProjectionLinkCollection();
  const dedupeCollection = createProjectionDedupeCollection();

  const store = new MongoProjectionStore<TState>({
    collection,
    linkCollection,
    dedupeCollection,
    mongoClient: createFakeMongoClient()
  });

  return {
    store: new RuntimeCoreMongoProjectionStore<TState>(store, linkCollection as InMemoryMongoCollection<LinkRecord>),
    collection,
    linkCollection,
    dedupeCollection
  };
};
