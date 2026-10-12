import type { VerifiedArtifact } from '../artifact';
import { referenceRegistry } from '../referenceRegistry';
import { createMongoClient, type ExternalConfig, type MongoClientFactory } from './mongoConnection';
import { openRegistryMongo } from './mongoWorker';
import type { StartupObserver } from '../startupDiagnostics';

export function openBrokerMongo(config: ExternalConfig, artifact: VerifiedArtifact, signal: AbortSignal, factory: MongoClientFactory = createMongoClient, observe?: StartupObserver) {
  return openRegistryMongo(config, referenceRegistry(artifact), signal, factory, observe);
}
