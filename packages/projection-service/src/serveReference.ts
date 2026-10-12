import type { VerifiedArtifact } from './artifact';
import type { HostConfig } from './config';
import { ProjectionHost } from './host';
import { Observations } from './observability';
import { acquireOwnership } from './ownership';
import { referenceResource } from './reference/hostResource';
import type { SignalSource } from './shutdown';

export function serveReference(artifact: VerifiedArtifact, config: HostConfig, signals: SignalSource,
  forceExit: (code: number) => void, output: (line: string) => void): Promise<number> {
  if (config.mode !== 'reference') throw new Error('external_host_unavailable');
  const observations = new Observations(output);
  const host = new ProjectionHost(config, { acquire: acquireOwnership, signals, forceExit, observations,
    async connect(_signal, fence) { return referenceResource(artifact, config, fence, observations); } });
  return host.start();
}
