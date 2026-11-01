import type { LiveStartRecord, ProjectionCommitDefinition, ProjectionDefinition } from '@redemeine/projection-runtime-core';

export interface LiveRegistration<TState> {
  readonly definition: ProjectionDefinition<TState>;
  readonly initialization: 'suffix_contributions' | 'history_dependent';
  readonly routing: 'event_stable_commutative' | 'dynamic';
}

export function validateLiveStart(start: LiveStartRecord): void {
  if ((start.mode !== 'LIVE_FROM_BOUNDARY' && start.mode !== 'LIVE_FROM_QUEUE_BINDING') || start.queueName !== 'rdm.projection.commits') {
    throw new Error('unsupported_start_mode');
  }
  const identities = [start.epoch, start.vhost, start.bindingRef, start.registryDigest, start.generation,
    start.sourceScopeDigest, start.provisioningRef];
  if (start.mode === 'LIVE_FROM_BOUNDARY') identities.push(start.nativeStartRef, start.publisherRef, start.orderedFeedQualificationRef);
  else {
    identities.push(start.queueNonce);
    if (start.publisherContract?.ordering !== 'external_single_ordered_publisher'
      || start.publisherContract.recoveryPolicy !== 'external_best_effort_on_expiry'
      || start.publisherContract.historicalCompleteness !== 'unknown'
      || 'nativeStartRef' in start || 'publisherRef' in start || 'orderedFeedQualificationRef' in start
      || Object.keys(start.publisherContract).length !== 3) throw new Error('unsupported_publisher_contract');
  }
  if (identities.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 512)) {
    throw new Error('unproven_live_start');
  }
}

export function normalizeLiveRegistration<TState>(registration: LiveRegistration<TState>): ProjectionCommitDefinition<TState> {
  if (registration.initialization !== 'suffix_contributions') throw new Error('unsupported_live_initialization');
  const definition = registration.definition;
  if (registration.routing !== 'event_stable_commutative' || definition.subscriptions.length > 0
    || definition.joinStreams?.length || definition.reverseSubscribeStreams?.length) {
    throw new Error('unsupported_live_routing');
  }
  const deduplication = definition.deduplication ?? { strategy: 'in_document' as const };
  if (deduplication.strategy === 'none') throw new Error('unsupported_live_deduplication');
  return Object.freeze({ ...definition, deduplication: Object.freeze({ ...deduplication }) });
}
