import type { VerifiedArtifact } from '../artifact';
import type { Observations } from '../observability';
import { referenceRegistry } from '../referenceRegistry';
import { registryResourceFactory, type BrokerFactories } from './brokerWorkerRuntime';
import { createMongoClient, type ExternalConfig } from './mongoConnection';
import { connectRabbit } from './rabbit';
export type { BrokerFactories } from './brokerWorkerRuntime';

export function brokerResourceFactory(config: ExternalConfig, artifact: VerifiedArtifact, observations: Observations,
  factories: BrokerFactories = { mongo: createMongoClient, rabbit: connectRabbit }) {
  return registryResourceFactory(config, artifact, referenceRegistry(artifact), observations, factories);
}
