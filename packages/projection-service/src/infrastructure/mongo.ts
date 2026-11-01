import { MongoLiveSourceOrder, type LiveSourcePositionDocument } from '@redemeine/projection-transport';
import type { LiveSourceOrderPort } from '@redemeine/projection-runtime-core';
import type { VerifiedArtifact } from '../artifact';
import { createMongoFixtureStores, mongoFixtureNamespace, probeReadOnlyTransaction } from './mongoFixtures';
import { createMongoClient, createMongoReader, openMongoClient, type ExternalConfig, type MongoClientFactory } from './mongoConnection';
import { InfrastructureError, retainUntilClosed } from './failure';
export { createMongoClient, createMongoReader, openMongoClient } from './mongoConnection';
export type { ExternalConfig, MongoClientFactory } from './mongoConnection';

export async function openMongoPrerequisites(config: ExternalConfig, artifact: VerifiedArtifact, signal: AbortSignal, factory: MongoClientFactory = createMongoClient) {
  const connection = await openMongoClient(config, signal, factory);
  try {
    const { client, assertOpen } = connection; const reader = await createMongoReader(client, config, assertOpen); const db = client.db(config.external.database);
    await probeReadOnlyTransaction(db, client, artifact, config.connectTimeoutMs); assertOpen();
    const order = new MongoLiveSourceOrder(db.collection<LiveSourcePositionDocument>(`${mongoFixtureNamespace(artifact)}_floors`));
    const sourceOrder: LiveSourceOrderPort = { async load(sourceId, epoch) { assertOpen(); return order.load(sourceId, epoch); },
      async admitFirst(evidence) { assertOpen(); return order.admitFirst(evidence); },
      async advanceCoverage(expected, sequence) { assertOpen(); return order.advanceCoverage(expected, sequence); } };
    return { reader, sourceOrder, uninitializedStores: createMongoFixtureStores(db, client, artifact, config.connectTimeoutMs), close: connection.close };
  } catch { await retainUntilClosed(connection.close); throw new InfrastructureError('mongo_prerequisite_failed'); }
}
