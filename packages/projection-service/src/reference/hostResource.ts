import type { VerifiedArtifact } from '../artifact';
import type { HostConfig } from '../config';
import type { HostResource } from '../hostAttempt';
import type { Observations } from '../observability';
import type { SessionFence } from '../sessionFence';
import { createReferenceRuntime, waitForModelTurn } from './runtime';
import { referenceScenario } from './scenario';

export function referenceResource(artifact: VerifiedArtifact, config: HostConfig, fence: SessionFence,
  observations: Observations): HostResource {
  const commits = referenceScenario();
  const runtime = createReferenceRuntime(artifact, config, commits, {
    wrapEvidence: (evidence) => fence.wrap(evidence), result: (result, ms) => observations.result(result, ms)
  });
  const close = runtime.channel.close.bind(runtime.channel);
  let closing: Promise<void> | undefined;
  // Worker drain and host cleanup join the same channel close, including a late failure.
  runtime.channel.close = () => { closing ??= close(); return closing; };
  return { worker: runtime.worker,
    async start() {
      await runtime.worker.start(runtime.channel);
      for (const _commit of commits) {
        if (fence.halted) return;
        runtime.channel.deliver();
        await waitForModelTurn(runtime.worker);
        if (!runtime.worker.getStatus().accepting) throw new Error('model:scenario_paused');
      }
    },
    async close() { await runtime.channel.close(); }
  };
}
