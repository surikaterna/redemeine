import type { LiveCommitResult, LiveFeedEvidencePort, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import type { VerifiedArtifact } from '../artifact';
import { composeRuntime } from '../composeRuntime';
import type { HostConfig } from '../config';
import { OrderedFeedModel } from './feedModel';
import { ModelChannel } from './modelChannel';
import { modelScope, modelStart } from './modelIdentity';
import { ModelCommitReader } from './memoryReader';
import { ModelCounterStore } from './memoryStore';
import { ModelSourceOrder } from './memoryOrder';

export interface ReferenceObservation {
  wrapEvidence(evidence: LiveFeedEvidencePort): LiveFeedEvidencePort;
  result(result: LiveCommitResult, milliseconds: number): void;
}

export function createReferenceRuntime(artifact: VerifiedArtifact, config: HostConfig, commits: readonly ProjectionSourceCommit[],
  observation?: ReferenceObservation) {
  if (config.mode !== 'reference') throw new Error('model:external_forbidden');
  const trace: string[] = [];
  const start = modelStart(artifact.registryDigest);
  const sourceOrder = new ModelSourceOrder(trace);
  const store = new ModelCounterStore(trace);
  const reader = new ModelCommitReader(commits, trace);
  const evidence = new OrderedFeedModel(start, trace);
  for (const commit of commits) evidence.append(commit);
  const channel = new ModelChannel(evidence);
  const runtime = composeRuntime(artifact, start, modelScope, config, {
    evidence: observation ? observation.wrapEvidence(evidence) : evidence, sourceOrder, store, reader,
    ...(observation ? { observe: (result: LiveCommitResult, milliseconds: number) => observation.result(result, milliseconds) } : {}) });
  return { ...runtime, start, sourceOrder, store, reader, evidence, channel, trace };
}

export async function waitForModelTurn(worker: ReturnType<typeof createReferenceRuntime>['worker']): Promise<void> {
  for (let turns = 0; turns < 1000; turns += 1) {
    if (worker.getStatus().activeDeliveries === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('model:turn_deadline');
}
