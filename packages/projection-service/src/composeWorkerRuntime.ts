import { performance } from 'node:perf_hooks';
import type { LiveCommitCoordinator, LiveCommitResult, LiveFeedEvidencePort, LiveSourceOrderPort, LiveStartRecord, ProjectionCompleteCommitRangeReader,
  ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { createLiveDeliveryGate, LiveProjectionRabbitWorker, type LiveDeliveryScope } from '@redemeine/projection-transport';
import { createLiveCommitCoordinator } from '@redemeine/projection-worker-core';
import type { HostOptions } from './config';
import type { RuntimeIdentity, RuntimeRegistry } from './runtimeRegistry';
import { brokerDeliveryGate } from './infrastructure/brokerDeliveryGate';

export interface RuntimePorts<TState> {
  readonly evidence: LiveFeedEvidencePort;
  readonly sourceOrder: LiveSourceOrderPort;
  readonly reader: ProjectionCompleteCommitRangeReader;
  readonly store: ProjectionSourceCommitStorePort<TState>;
  readonly observe?: (result: LiveCommitResult, milliseconds: number) => void;
  readonly brokerSessionCurrent?: () => void;
}

function observedCoordinator(coordinator: LiveCommitCoordinator, observe: RuntimePorts<unknown>['observe']): LiveCommitCoordinator {
  if (!observe) return coordinator;
  return { epoch: coordinator.epoch, registryDigest: coordinator.registryDigest, generation: coordinator.generation,
    async process(commit, position, assertCurrent) {
      const started = performance.now();
      const result = await coordinator.process(commit, position, assertCurrent);
      observe(result, performance.now() - started);
      return result;
    } };
}

/** Constructs only. The later lifecycle owner must authorize startup under its lock. */
export function composeWorkerRuntime<TState>(artifact: RuntimeIdentity, registry: RuntimeRegistry<TState>, start: LiveStartRecord, scope: LiveDeliveryScope,
  options: HostOptions, ports: RuntimePorts<TState>) {
  if (start.registryDigest !== artifact.registryDigest || registry.registryDigest !== artifact.registryDigest) throw new Error('artifact_registry_mismatch');
  const coordinator = observedCoordinator(createLiveCommitCoordinator({ epoch: start.epoch, registryDigest: artifact.registryDigest,
    definitions: registry.definitions(start.generation), store: ports.store, sourceOrder: ports.sourceOrder,
    rangeReader: ports.reader, budget: options.budget }), ports.observe);
  if (start.mode === 'LIVE_FROM_QUEUE_BINDING' && !ports.brokerSessionCurrent) throw new Error('broker_session_guard_required');
  const gate = start.mode === 'LIVE_FROM_QUEUE_BINDING' && ports.brokerSessionCurrent
    ? brokerDeliveryGate(scope, ports.reader, options.budget.maxBytes, ports.sourceOrder, start.epoch, ports.brokerSessionCurrent)
    : createLiveDeliveryGate(scope, ports.reader, options.budget.maxBytes);
  const worker = new LiveProjectionRabbitWorker({ start, evidence: ports.evidence, sourceOrder: ports.sourceOrder,
    gate, coordinator, continuationDelayMs: options.continuationDelayMs, shutdownTimeoutMs: options.shutdownTimeoutMs });
  return { coordinator, gate, worker };
}
