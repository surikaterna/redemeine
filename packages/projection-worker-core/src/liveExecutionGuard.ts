import {
  isProjectionUuidBase64Url22, projectionUuidToBase64Url22,
  type ProjectionCommitDefinition, type ProjectionSourceCommit, type ProjectionSourceCommitSnapshot
} from '@redemeine/projection-runtime-core';

export interface LiveExecutionProfile {
  readonly coveredDuplicate: boolean;
  readonly assertCurrent: () => void;
}

export function assertLiveRouting<TState>(definition: ProjectionCommitDefinition<TState>): void {
  if (definition.subscriptions.length > 0 || definition.joinStreams?.length || definition.reverseSubscribeStreams?.length) {
    throw new Error('unsupported_live_routing');
  }
}

export function snapshotLiveDefinition<TState>(definition: ProjectionCommitDefinition<TState>): ProjectionCommitDefinition<TState> {
  assertLiveRouting(definition);
  const identity = definition.identity;
  return { ...definition, deduplication: { ...definition.deduplication }, subscriptions: [],
    joinStreams: [], reverseSubscribeStreams: [],
    fromStream: { ...definition.fromStream, aggregate: { ...definition.fromStream.aggregate },
      handlers: { ...definition.fromStream.handlers } },
    ...(definition.hooks ? { hooks: { ...definition.hooks } } : {}),
    identity: (event) => {
      const target = identity(event);
      // This slice qualifies at most one event-derived target per event, not arbitrary fanout.
      if (Array.isArray(target) && target.length === 0) return [];
      if (typeof target !== 'string' || target.length === 0 || target.length > 512) throw new Error('unsupported_live_routing');
      return target;
    }
  };
}

export function assertLiveSnapshot<TState>(profile: LiveExecutionProfile, definition: ProjectionCommitDefinition<TState>,
  commit: ProjectionSourceCommit, snapshot: ProjectionSourceCommitSnapshot<TState>): void {
  profile.assertCurrent();
  assertLiveRouting(definition);
  if (definition.deduplication.strategy === 'own_record') {
    const sequence = snapshot.ownRecordSequence;
    if (sequence !== null && (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0)) {
      throw new Error('marker_lifetime_violation');
    }
    return;
  }
  if (definition.deduplication.strategy !== 'in_document') return;
  const key = projectionUuidToBase64Url22(commit.streamId);
  for (const target of snapshot.targets) {
    const markers = Object.entries(target.sourceProgress);
    if ((target.state === null) !== (markers.length === 0)
      || markers.some(([source, sequence]) => !isProjectionUuidBase64Url22(source) || !Number.isSafeInteger(sequence) || sequence < 0)) {
      throw new Error('marker_lifetime_violation');
    }
    const marker = target.sourceProgress[key];
    if (profile.coveredDuplicate && (marker === undefined || marker < commit.commitSequence)) {
      throw new Error('marker_lifetime_violation');
    }
  }
}
