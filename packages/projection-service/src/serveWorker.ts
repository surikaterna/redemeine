import { ProjectionHost } from './host';
import { Observations } from './observability';
import { acquireOwnership } from './ownership';
import type { SignalSource } from './shutdown';
import type { RuntimeIdentity, RuntimeRegistry } from './runtimeRegistry';
import type { ExternalConfig } from './infrastructure/mongoConnection';
import { registryResourceFactory } from './infrastructure/brokerWorkerRuntime';

export function serveWorker(identity: RuntimeIdentity, registry: RuntimeRegistry, config: ExternalConfig,
  signals: SignalSource, forceExit: (code: number) => void, output: (line: string) => void): Promise<number> {
  const observations = new Observations(output, 'external');
  return new ProjectionHost(config, { acquire: acquireOwnership, signals, forceExit, observations,
    connect: registryResourceFactory(config, identity, registry, observations) }).start();
}
