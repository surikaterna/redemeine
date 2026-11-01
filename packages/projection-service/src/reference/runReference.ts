import type { VerifiedArtifact } from '../artifact';
import type { HostConfig } from '../config';
import { createReferenceRuntime, waitForModelTurn } from './runtime';
import { firstSource, referenceScenario } from './scenario';

async function executeScenario(runtime: ReturnType<typeof createReferenceRuntime>, artifact: VerifiedArtifact, count: number) {
  await runtime.worker.start(runtime.channel);
  for (let index = 0; index < count; index += 1) {
    runtime.channel.deliver();
    await waitForModelTurn(runtime.worker);
    if (!runtime.worker.getStatus().accepting) throw new Error('model:scenario_paused');
  }
  const floor = await runtime.sourceOrder.load(firstSource, runtime.start.epoch);
  return Object.freeze({ mode: 'reference', evidence: 'model:ordered-history', productionReady: false,
    referenceOnly: true, outcome: 'model:completed', firstSequence: floor?.firstSequence,
    coveredThrough: floor?.coveredThrough, acknowledgements: runtime.channel.acknowledgements,
    inlineCount: runtime.store.count('model:inline-counter'), ownRecordCount: runtime.store.count('model:own-counter'),
    artifactDigest: artifact.digest, registryDigest: artifact.registryDigest });
}

export async function runReference(artifact: VerifiedArtifact, config: HostConfig) {
  const commits = referenceScenario();
  const runtime = createReferenceRuntime(artifact, config, commits);
  let report: Awaited<ReturnType<typeof executeScenario>>;
  let drained = false;
  try { report = await executeScenario(runtime, artifact, commits.length); }
  finally { drained = (await runtime.worker.stop()).drained; }
  if (!drained) throw new Error('model:drain_failed');
  return report;
}
