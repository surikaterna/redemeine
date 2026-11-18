import type {
  CommitProjectionSourceCommitRequest,
  ProjectionChangeTransition,
  ProjectionCommitDefinition,
  ProjectionContext,
  ProjectionJsonValue,
  ProjectionSourceCommit,
  ProjectionSourceCommitLink,
  ProjectionSourceCommitSnapshot,
  ProjectionSourceCommitStatePatch,
  ProjectionSourceEvent,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import {
  equalProjectionChangeJson, isCertifiedProjectionSnapshotJson, isFrozenPortableProjectionChangeJson, isPortableProjectionChangeJson,
  MISSING_PROJECTION_CHANGES_HISTORY, projectionUuidToBase64Url22
} from '@redemeine/projection-runtime-core';
import { enablePatches, produce, produceWithPatches, type Draft, type Patch } from 'immer';
import { linksByKey, routeEvent, type RoutedEvent, type RoutingLinkState } from './projectionCommitRouting';
import { createProjectionChangeTransition, type CapturedHandlerPatches } from './projectionChangeTransition';

let patchesEnabled = false;

export type ProjectionReductionResult<TState> =
  | { status: 'planned'; request: CommitProjectionSourceCommitRequest<TState> }
  | { status: 'deduplicated' }
  | { status: 'needs_snapshot'; targetIds: readonly string[]; links: readonly { aggregateType: string; aggregateId: string }[] }
  | { status: 'terminal'; reason: string };

interface ReducedDocument<TState> {
  state: TState;
  revision: number | null;
  absent: boolean;
  transitions: ProjectionChangeTransition[];
  frozenPortableState?: ProjectionJsonValue;
  patchFallback?: Extract<ProjectionSourceCommitStatePatch, { kind: 'full' }>['reason'];
  legacyOriginal?: ProjectionSourceCommitSnapshot<TState>['targets'][number]['legacyOriginal'];
}

interface ReductionState<TState> {
  documents: Map<string, ReducedDocument<TState>>;
  changeFeed?: string;
  previouslyAppliedTarget?: boolean;
  touched: Set<string>;
  links: Map<string, RoutingLinkState>;
  stagedLinks: Map<string, ProjectionSourceCommitLink>;
  missingTargets: Set<string>;
  missingLinks: Map<string, { aggregateType: string; aggregateId: string }>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canApplyToTarget<TState>(
  definition: ProjectionCommitDefinition<TState>,
  snapshot: ProjectionSourceCommitSnapshot<TState>,
  targetId: string,
  sourceKey: ProjectionUuidBase64Url22,
  sequence: number
): boolean {
  if (definition.deduplication.strategy !== 'in_document') return true;
  const marker = snapshot.targets.find((target) => target.targetDocumentId === targetId)?.sourceProgress[sourceKey];
  return marker === undefined || sequence > marker;
}

function getDocument<TState>(
  definition: ProjectionCommitDefinition<TState>,
  snapshot: ProjectionSourceCommitSnapshot<TState>,
  reduction: ReductionState<TState>,
  targetId: string
): ReducedDocument<TState> | null {
  const existing = reduction.documents.get(targetId);
  if (existing) return existing;
  const target = snapshot.targets.find((candidate) => candidate.targetDocumentId === targetId);
  if (!target) {
    reduction.missingTargets.add(targetId);
    return null;
  }
  const absent = target.state === null && target.revision === null && target.legacyOriginal === undefined;
  const initialize = reduction.changeFeed !== undefined ? absent : target.state === null;
  const frozen = !initialize && isCertifiedProjectionSnapshotJson(target.state) ? target.state : undefined;
  const document: ReducedDocument<TState> = {
    // A stored JSON null is a document in the commit-native feed.
    state: initialize ? definition.initialState(targetId) : frozen !== undefined ? frozen as TState : clone(target.state as TState),
    revision: target.revision,
    absent,
    transitions: [],
    ...(frozen !== undefined ? { frozenPortableState: frozen } : {}),
    ...(initialize && !absent ? { patchFallback: 'unrepresentable-patch' } : {}),
    ...(target.legacyOriginal ? { legacyOriginal: target.legacyOriginal } : {})
  };
  reduction.documents.set(targetId, document);
  return document;
}

function stageLink<TState>(
  reduction: ReductionState<TState>,
  operation: 'subscribe' | 'unsubscribe',
  aggregateType: string,
  aggregateId: string,
  targetDocumentId: string
): void {
  const key = `${aggregateType}\u0000${aggregateId}`;
  const current = reduction.links.get(key);
  if (!current) {
    reduction.missingLinks.set(key, { aggregateType, aggregateId });
    reduction.links.set(key, {
      aggregateType,
      aggregateId,
      targetDocumentId: operation === 'subscribe' ? targetDocumentId : null,
      revision: null
    });
    return;
  }
  reduction.stagedLinks.set(key, {
    operation,
    aggregateType,
    aggregateId,
    targetDocumentId,
    expectedRevision: current.revision
  });
  reduction.links.set(key, {
    ...current,
    targetDocumentId: operation === 'subscribe' ? targetDocumentId : null
  });
}

function createContext<TState>(reduction: ReductionState<TState>, targetId: string): ProjectionContext {
  return {
    subscribeTo(aggregate, aggregateId) {
      stageLink(reduction, 'subscribe', aggregate.aggregateType, aggregateId, targetId);
    },
    unsubscribeFrom(aggregate, aggregateId) {
      stageLink(reduction, 'unsubscribe', aggregate.aggregateType, aggregateId, targetId);
    }
  };
}

function createProgress<TState>(
  definition: ProjectionCommitDefinition<TState>,
  commit: ProjectionSourceCommit,
  snapshot: ProjectionSourceCommitSnapshot<TState>,
  targetIds: readonly string[],
  sourceKey: ProjectionUuidBase64Url22,
  baselineSequence?: number
): CommitProjectionSourceCommitRequest<TState>['progress'] {
  const strategy = definition.deduplication;
  if (strategy.strategy === 'none') return { strategy: 'none' };
  if (strategy.strategy === 'own_record') {
    return {
      strategy: 'own_record',
      source: { sourceId: commit.streamId, expectedSequence: snapshot.ownRecordSequence, finalSequence: commit.commitSequence,
        ...(snapshot.ownRecordSequence === null && baselineSequence !== undefined ? { baselineSequence } : {}) },
      ...(strategy.warnings ? { warnings: strategy.warnings } : {})
    };
  }
  return {
    strategy: 'in_document',
    targets: targetIds.map((targetDocumentId) => {
      const expected = snapshot.targets.find((target) => target.targetDocumentId === targetDocumentId)?.sourceProgress ?? {};
      return { targetDocumentId, expected, final: { ...expected, [sourceKey]: commit.commitSequence } };
    }),
    ...(strategy.warnings ? { warnings: strategy.warnings } : {})
  };
}

function needsSnapshot<TState>(reduction: ReductionState<TState>): ProjectionReductionResult<TState> | null {
  if (reduction.missingTargets.size === 0 && reduction.missingLinks.size === 0) return null;
  return {
    status: 'needs_snapshot',
    targetIds: [...reduction.missingTargets].sort(),
    links: [...reduction.missingLinks.values()]
  };
}

function applyHandler<TState>(
  definition: ProjectionCommitDefinition<TState>,
  reduction: ReductionState<TState>,
  document: { state: TState },
  routed: RoutedEvent<TState>,
  targetId: string,
  capture: boolean
): CapturedHandlerPatches | undefined {
  const recipe = (draft: Draft<TState>): void => {
    routed.handler(draft, routed.event, createContext(reduction, targetId));
  };
  let patches: readonly Patch[] | undefined;
  if (capture) {
    if (!patchesEnabled) {
      enablePatches();
      patchesEnabled = true;
    }
    [document.state, patches] = produceWithPatches(document.state, recipe);
  } else {
    document.state = produce(document.state, recipe);
  }
  const beforeHook = document.state;
  if (definition.hooks?.afterEach) {
    const state = clone(beforeHook);
    definition.hooks.afterEach(state, routed.event);
    document.state = state;
  }
  reduction.touched.add(targetId);
  return patches && { patches, ...(definition.hooks?.afterEach ? { beforeHook: { state: beforeHook } } : {}) };
}

function canTrackState(state: unknown, recording: boolean, frozen = false): state is ProjectionJsonValue {
  try {
    return frozen ? isFrozenPortableProjectionChangeJson(state) : isPortableProjectionChangeJson(state);
  } catch (error) {
    if (recording && !frozen) throw error;
    return false;
  }
}

function trackResult<TState>(
  document: ReducedDocument<TState>, before: ProjectionJsonValue | undefined, recording: boolean, mutableHook: boolean
): ProjectionJsonValue | undefined {
  const { state, frozenPortableState } = document;
  if (!mutableHook && frozenPortableState !== undefined && Object.is(frozenPortableState, state)) return frozenPortableState;
  delete document.frozenPortableState;
  // Reuse only after an unchanged Immer result has been proven deeply frozen, never across a mutable hook.
  if (!mutableHook && Object.is(before, state) && canTrackState(state, recording, true)) {
    document.frozenPortableState = state;
    return state;
  }
  return canTrackState(state, recording) ? state : undefined;
}

function applyTargetEvent<TState>(
  definition: ProjectionCommitDefinition<TState>,
  reduction: ReductionState<TState>,
  document: ReducedDocument<TState>,
  routed: RoutedEvent<TState>,
  targetId: string,
  sourceEvent: ProjectionSourceEvent
): void {
  const recording = reduction.changeFeed !== undefined;
  const creating = document.absent && !reduction.touched.has(targetId);
  let before: ProjectionJsonValue | undefined;
  if (!creating && !document.patchFallback) {
    const cached = document.frozenPortableState;
    if (cached !== undefined && Object.is(cached, document.state)) before = cached;
    else if (canTrackState(document.state, recording)) before = document.state;
    else if (recording) throw new Error('Projection change snapshot must be portable JSON.');
    else document.patchFallback = 'nonportable-state';
  }
  const patches = applyHandler(definition, reduction, document, routed, targetId, !document.patchFallback && !creating);
  if (document.patchFallback) return;
  const after = trackResult(document, before, recording, definition.hooks?.afterEach !== undefined);
  if (after === undefined) {
    if (recording) throw new Error('Projection changes require portable JSON document state.');
    document.patchFallback = 'nonportable-state';
  } else {
    try {
      const transition = createProjectionChangeTransition(sourceEvent, before, after, creating, patches);
      if (!recording && transition.changeType === 'noop' && before !== undefined
        && !equalProjectionChangeJson(before, after, true)) {
        document.patchFallback = 'unrepresentable-patch';
      } else document.transitions.push(clone(transition));
    } catch (error) {
      if (recording) throw error;
      document.patchFallback = 'unrepresentable-patch';
    }
  }
  if (document.patchFallback) document.transitions.length = 0;
}

function applyEvents<TState>(
  definition: ProjectionCommitDefinition<TState>,
  commit: ProjectionSourceCommit,
  snapshot: ProjectionSourceCommitSnapshot<TState>,
  reduction: ReductionState<TState>,
  sourceKey: ProjectionUuidBase64Url22
): void {
  for (const sourceEvent of commit.events) {
    const routed = routeEvent(definition, sourceEvent, reduction.links);
    if (!routed) continue;
    for (const targetId of routed.targetIds) {
      if (!canApplyToTarget(definition, snapshot, targetId, sourceKey, commit.commitSequence)) {
        if (reduction.changeFeed !== undefined) {
          reduction.previouslyAppliedTarget = true;
          return;
        }
        continue;
      }
      const document = getDocument(definition, snapshot, reduction, targetId);
      if (document) applyTargetEvent(definition, reduction, document, routed, targetId, sourceEvent);
    }
  }
}

function createRequest<TState>(
  definition: ProjectionCommitDefinition<TState>,
  generation: string,
  commit: ProjectionSourceCommit,
  snapshot: ProjectionSourceCommitSnapshot<TState>,
  reduction: ReductionState<TState>,
  sourceKey: ProjectionUuidBase64Url22,
  baselineSequence?: number
): CommitProjectionSourceCommitRequest<TState> {
  const targetIds = [...reduction.touched].sort();
  const finalDocuments = targetIds.map((targetDocumentId) => {
    const document = reduction.documents.get(targetDocumentId);
    if (!document) throw new Error(`Missing reduced document ${targetDocumentId}.`);
    return { targetDocumentId, expectedRevision: document.revision, finalDocument: document.state,
      statePatch: document.patchFallback ? { kind: 'full' as const, reason: document.patchFallback }
        : { kind: 'ordered' as const, transitions: document.transitions },
      ...(document.legacyOriginal ? { legacyOriginal: document.legacyOriginal } : {}) };
  });
  return {
    version: 1, mode: 'atomic-all', projectionName: definition.name, projectionGeneration: generation,
    commit, finalDocuments, stagedLinks: [...reduction.stagedLinks.values()],
    progress: createProgress(definition, commit, snapshot, targetIds, sourceKey, baselineSequence),
    ...(reduction.changeFeed !== undefined ? { additionalWrites: [{
      kind: 'projection_changes',
      collection: reduction.changeFeed,
      targets: finalDocuments.map(({ targetDocumentId, statePatch }) => ({
        targetDocumentId, transitions: statePatch.kind === 'ordered' ? statePatch.transitions : []
      }))
    }] } : {})
  };
}

function allResolvedTargetsDeduplicated<TState>(
  definition: ProjectionCommitDefinition<TState>,
  commit: ProjectionSourceCommit,
  reduction: ReductionState<TState>
): boolean {
  return definition.deduplication.strategy === 'in_document'
    && reduction.touched.size === 0
    && commit.events.some((event) => routeEvent(definition, event, reduction.links)?.targetIds.length);
}

export function reduceProjectionSourceCommit<TState>(
  definition: ProjectionCommitDefinition<TState>,
  generation: string,
  commit: ProjectionSourceCommit,
  snapshot: ProjectionSourceCommitSnapshot<TState>,
  baselineSequence?: number,
  projectionChanges?: string
): ProjectionReductionResult<TState> {
  if (projectionChanges !== undefined && definition.deduplication.strategy !== 'none'
    && snapshot.changeReceipt && snapshot.changeReceipt !== 'missing') {
    return snapshot.changeReceipt === 'committed' ? { status: 'deduplicated' }
      : { status: 'terminal', reason: 'projection change source commit or collection identity mismatch' };
  }
  if (projectionChanges !== undefined && definition.deduplication.strategy !== 'none'
    && commit.commitSequence <= (baselineSequence ?? -1)) return { status: 'deduplicated' };
  if (definition.deduplication.strategy === 'own_record'
    && snapshot.ownRecordSequence !== null
    && commit.commitSequence <= snapshot.ownRecordSequence) {
    return projectionChanges !== undefined
      ? { status: 'terminal', reason: MISSING_PROJECTION_CHANGES_HISTORY } : { status: 'deduplicated' };
  }
  const sourceKey = projectionUuidToBase64Url22(commit.streamId);
  const reduction: ReductionState<TState> = {
    documents: new Map(), touched: new Set(), links: linksByKey(snapshot.links), stagedLinks: new Map(),
    missingTargets: new Set(), missingLinks: new Map(),
    ...(projectionChanges === undefined ? {} : { changeFeed: projectionChanges })
  };
  try {
    applyEvents(definition, commit, snapshot, reduction, sourceKey);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'projection handler threw';
    return { status: 'terminal', reason };
  }
  if (reduction.previouslyAppliedTarget) return { status: 'terminal', reason: MISSING_PROJECTION_CHANGES_HISTORY };
  const missing = needsSnapshot(reduction);
  if (missing) return missing;
  try {
    if (allResolvedTargetsDeduplicated(definition, commit, reduction)) return { status: 'deduplicated' };
    return { status: 'planned', request: createRequest(definition, generation, commit, snapshot, reduction, sourceKey, baselineSequence) };
  } catch (error) {
    return { status: 'terminal', reason: error instanceof Error ? error.message : 'projection plan failed' };
  }
}
