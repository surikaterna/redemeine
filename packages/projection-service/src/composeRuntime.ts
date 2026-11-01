import type { VerifiedArtifact } from './artifact';
import type { LiveStartRecord } from '@redemeine/projection-runtime-core';
import type { LiveDeliveryScope } from '@redemeine/projection-transport';
import type { HostOptions } from './config';
import type { CounterState } from './fixtureRegistry';
import { referenceRegistry } from './referenceRegistry';
import { composeWorkerRuntime, type RuntimePorts } from './composeWorkerRuntime';

export function composeRuntime(artifact: VerifiedArtifact, start: LiveStartRecord, scope: LiveDeliveryScope,
  options: HostOptions, ports: RuntimePorts<CounterState>) {
  return composeWorkerRuntime(artifact, referenceRegistry(artifact), start, scope, options, ports);
}
