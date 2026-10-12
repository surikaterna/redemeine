import { MongoProjectionStore, type ProjectionDedupeRecord, type ProjectionDocumentRecord,
  type ProjectionLinkRecord } from '@redemeine/projection-runtime-store-mongodb';
import type { Db, MongoClient } from 'mongodb';
import type { VerifiedArtifact } from '../artifact';
import { fixtureRegistry, type CounterState } from '../fixtureRegistry';

export function mongoFixtureNamespace(artifact: VerifiedArtifact, epoch?: string): string {
  return `rdm_fixture_${artifact.registryDigest}${epoch ? `_${epoch}` : ''}`;
}

/** These concrete stores remain uninitialized: their initialization creates an index. */
export function createMongoFixtureStores(db: Db, client: MongoClient, artifact: VerifiedArtifact, timeout: number,
  epoch?: string, selectedGeneration?: string) {
  return Object.freeze(fixtureRegistry(selectedGeneration).map(({ definition, generation }, index) => {
    const namespace = `${mongoFixtureNamespace(artifact, epoch)}_${index}`;
    const store = new MongoProjectionStore<CounterState>({
      collection: db.collection<ProjectionDocumentRecord<CounterState>>(`${namespace}_documents`),
      linkCollection: db.collection<ProjectionLinkRecord>(`${namespace}_links`),
      dedupeCollection: db.collection<ProjectionDedupeRecord>(`${namespace}_dedupe`),
      mongoClient: client, transactionOptions: { maxCommitTimeMS: timeout }
    });
    return Object.freeze({ projectionName: definition.name, generation, store });
  }));
}

export async function probeReadOnlyTransaction(db: Db, client: MongoClient, artifact: VerifiedArtifact, timeout: number): Promise<void> {
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await db.collection<ProjectionDedupeRecord>(`${mongoFixtureNamespace(artifact)}_0_dedupe`)
        .findOne({ _id: '__redemeine_v2_readiness__' }, { session, maxTimeMS: timeout });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: timeout });
  } finally { await session.endSession(); }
}
