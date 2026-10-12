import { MongoProjectionStore, type ProjectionDocumentRecord, type ProjectionLinkRecord, type ProjectionDedupeRecord } from '@redemeine/projection-runtime-store-mongodb';
import type { Db, MongoClient } from 'mongodb';
import type { RuntimeRegistry } from '../runtimeRegistry';

export function createMongoRegistryStores<TState>(db: Db, client: MongoClient, registry: RuntimeRegistry<TState>, timeout: number, epoch: string, generation: string) {
  return Object.freeze(registry.definitions(generation).map(({ definition, generation }, index) => {
    const namespace = `${registry.namespace(epoch)}_${index}`;
    const store = new MongoProjectionStore<TState>({ collection: db.collection<ProjectionDocumentRecord<TState>>(`${namespace}_documents`),
      linkCollection: db.collection<ProjectionLinkRecord>(`${namespace}_links`), dedupeCollection: db.collection<ProjectionDedupeRecord>(`${namespace}_dedupe`),
      mongoClient: client, transactionOptions: { maxCommitTimeMS: timeout } });
    return Object.freeze({ projectionName: definition.name, generation, store });
  }));
}
