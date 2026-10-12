import type { VerifiedArtifact } from '../artifact';
import type { HostConfig } from '../config';
import { ProjectionHost } from '../host';
import { Observations } from '../observability';
import { acquireOwnership } from '../ownership';
import type { SignalSource } from '../shutdown';
import { createMongoClient, openMongoPrerequisites, type MongoClientFactory } from './mongo';
import { connectRabbit, openRabbitPrerequisites, type RabbitConnector } from './rabbit';
import { closeOnce, closeResources, retainUntilClosed } from './failure';
import { brokerResourceFactory, type BrokerFactories } from './brokerRuntime';

export interface InfrastructureFactories extends BrokerFactories { readonly mongo: MongoClientFactory; readonly rabbit: RabbitConnector }
const driverFactories: InfrastructureFactories = { mongo: createMongoClient, rabbit: connectRabbit };

/** Internal, read-only prerequisite capability. Inspecting it never grants consumption or provisioning. */
export function selectExternalInfrastructure(config: HostConfig, artifact: VerifiedArtifact,
  factories: InfrastructureFactories = driverFactories) {
  if (config.mode !== 'external') throw new Error('external_mode_required');
  return { connect: brokerResourceFactory(config, artifact, new Observations(undefined, 'external'), factories),
    async inspectPrerequisites(signal: AbortSignal) {
      const mongo = await openMongoPrerequisites(config, artifact, signal, factories.mongo);
      try {
        const rabbit = await openRabbitPrerequisites(config, signal, factories.rabbit);
        return { mongo, rabbit, close: closeOnce(() => closeResources([rabbit.close, mongo.close])) };
      } catch (error) { await retainUntilClosed(mongo.close); throw error; }
    }
  };
}

export function serveExternal(artifact: VerifiedArtifact, config: HostConfig, signals: SignalSource,
  forceExit: (code: number) => void, output: (line: string) => void): Promise<number> {
  if (config.mode !== 'external') throw new Error('external_mode_required');
  const observations = new Observations(output, 'external');
  return new ProjectionHost(config, { acquire: acquireOwnership, signals, forceExit, observations,
    connect: brokerResourceFactory(config, artifact, observations) }).start();
}
