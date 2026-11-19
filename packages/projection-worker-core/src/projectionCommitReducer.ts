import { isDeepStrictEqual } from 'node:util';
import type {
  CommitProjectionSourceCommitRequest,
  ProjectionChangeTransition,
  ProjectionCommitDefinition,
  ProjectionContext,
  ProjectionJoinMembership,
  ProjectionSourceCommit,
  ProjectionSourceCommitLink,
  ProjectionSourceCommitSnapshot,
  ProjectionSourceCommitStatePatch,
  ProjectionSourceEvent,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import {
  captureProjectionSourceEvent, isCertifiedProjectionSnapshotJson, isNativeProjectionCaptureSnapshot, isOwnedProjectionState, isPortableProjectionChangeJson,
  joinMembershipKey, MISSING_PROJECTION_CHANGES_HISTORY, projectionUuidToBase64Url22, sealProjectionCaptureRequest
} from '@redemeine/projection-runtime-core';
import { produce, type Draft } from 'immer';
import { linksByKey, routeEvent, type RoutedEvent, type RoutingLinkState, type SetRoutingEntry } from './projectionCommitRouting';
import { membershipFences, routeStagedSetEvent, stageMembership } from './joinMembershipReduction';

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
  patchFallback?: Extract<ProjectionSourceCommitStatePatch, { kind: 'full' }>['reason'];
  legacyOriginal?: ProjectionSourceCommitSnapshot<TState>['targets'][number]['legacyOriginal'];
}

interface ReductionState<TState> {
  documents: Map<string, ReducedDocument<TState>>;
  changeFeed?: string;
  validation?: ProjectionStateValidation;
  nativeSnapshot?: ProjectionSourceCommitSnapshot<TState>;
  previouslyAppliedTarget?: boolean;
  touched: Set<string>;
  links: Map<string, RoutingLinkState>;
  memberships?: Map<string, ProjectionJoinMembership>;
  setEvents?: readonly (SetRoutingEntry<TState> | null)[];
  membershipReads: Set<string>;
  snapshotTargets: ReadonlyMap<string, ProjectionSourceCommitSnapshot<TState>['targets'][number]>;
  stagedLinks: Map<string, ProjectionSourceCommitLink>;
  missingTargets: Set<string>;
  missingLinks: Map<string, { aggregateType: string; aggregateId: string }>;
}

export interface ProjectionStateValidation {
  readonly load?: boolean;
  readonly changes?: boolean;
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
  reduction: ReductionState<TState>,
  targetId: string
): ReducedDocument<TState> | null {
  const existing = reduction.documents.get(targetId);
  if (existing) return existing;
  const target = reduction.snapshotTargets.get(targetId);
  if (!target) {
    reduction.missingTargets.add(targetId);
    return null;
  }
  const absent = target.state === null && target.revision === null && target.legacyOriginal === undefined;
  const initialize = reduction.changeFeed !== undefined ? absent : target.state === null;
  if (!absent && (reduction.validation?.load || reduction.validation?.changes) && !isPortableProjectionChangeJson(target.state)) {
    throw new Error('Projection change snapshot must be portable JSON.');
  }
  const owned = reduction.nativeSnapshot || isOwnedProjectionState(target.state) || isCertifiedProjectionSnapshotJson(target.state);
  const document: ReducedDocument<TState> = {
    // A stored JSON null is a document in the commit-native feed.
    state: initialize ? definition.initialState(targetId) : owned ? target.state as TState : clone(target.state as TState),
    revision: target.revision,
    absent,
    transitions: [],
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
  if (reduction.memberships) {
    reduction.membershipReads.add(joinMembershipKey(aggregateType, aggregateId));
    stageMembership(reduction.memberships, reduction.missingLinks, { aggregateType, aggregateId },
      targetDocumentId, operation === 'subscribe');
    return;
  }
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

function createContext<TState>(reduction: ReductionState<TState>, targetId: string, attached?: Set<string>): ProjectionContext {
  return {
    subscribeTo(aggregate, aggregateId) {
      stageLink(reduction, 'subscribe', aggregate.aggregateType, aggregateId, targetId);
      attached?.add(joinMembershipKey(aggregate.aggregateType, aggregateId));
    },
    unsubscribeFrom(aggregate, aggregateId) {
      stageLink(reduction, 'unsubscribe', aggregate.aggregateType, aggregateId, targetId);
      attached?.delete(joinMembershipKey(aggregate.aggregateType, aggregateId));
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
  document: ReducedDocument<TState>,
  routed: RoutedEvent<TState>,
  targetId: string,
  sourceEvent: ProjectionSourceEvent,
  creating: boolean,
  attached?: Set<string>
): ProjectionChangeTransition | undefined {
  const recipe = (draft: Draft<TState>): void => {
    routed.handler(draft, routed.event, createContext(reduction, targetId, attached));
    const hookResult: unknown = definition.hooks?.afterEach?.(draft, routed.event);
    if (hookResult && typeof (hookResult as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(hookResult).catch(() => undefined);
      throw new Error('Projection afterEach must be synchronous.');
    }
  };
  if (document.patchFallback) {
    document.state = produce(document.state, recipe);
    return undefined;
  }
  const captured = captureProjectionSourceEvent(document.state, sourceEvent, recipe, creating,
    reduction.nativeSnapshot ? { snapshot: reduction.nativeSnapshot, targetId } : undefined);
  document.state = captured.state;
  return captured.transition;
}

function applyTargetEvent<TState>(
  definition: ProjectionCommitDefinition<TState>,
  reduction: ReductionState<TState>,
  document: ReducedDocument<TState>,
  routed: RoutedEvent<TState>,
  targetId: string,
  sourceEvent: ProjectionSourceEvent
): void {
  const creating = document.absent && !reduction.touched.has(targetId);
  const before = document.state;
  const attached = routed.savedMembers && !routed.savedMembers.has(targetId) ? new Set<string>() : undefined;
  const transition = applyHandler(definition, reduction, document, routed, targetId, sourceEvent, creating, attached);
  if (creating && attached && !attached.size && isDeepStrictEqual(before, document.state)) {
    document.state = before;
    return;
  }
  reduction.touched.add(targetId);
  if (reduction.validation?.changes && (creating || !Object.is(before, document.state))
    && !isPortableProjectionChangeJson(document.state)) {
    throw new Error('Projection change final document must be portable JSON.');
  }
  if (transition) document.transitions.push(transition);
  else {
    if (reduction.changeFeed !== undefined) throw new Error('Projection changes require immutable portable JSON state.');
    document.patchFallback ??= 'nonportable-state';
    document.transitions.length = 0;
  }
}

function applyEvents<TState>(
  definition: ProjectionCommitDefinition<TState>,
  commit: ProjectionSourceCommit,
  snapshot: ProjectionSourceCommitSnapshot<TState>,
  reduction: ReductionState<TState>,
  sourceKey: ProjectionUuidBase64Url22
): void {
  for (const [index, sourceEvent] of commit.events.entries()) {
    const entry = reduction.setEvents?.[index];
    const routed = reduction.memberships ? entry && routeStagedSetEvent(entry, reduction.memberships)
      : routeEvent(definition, sourceEvent, reduction.links);
    if (!routed) continue;
    if (reduction.memberships) {
      if (routed.savedMembers) reduction.membershipReads.add(joinMembershipKey(routed.event.aggregateType, routed.event.aggregateId));
      for (const id of routed.targetIds) if (!reduction.snapshotTargets.has(id)) reduction.missingTargets.add(id);
      if (reduction.missingTargets.size) return;
    }
    for (const targetId of routed.targetIds) {
      if (!canApplyToTarget(definition, snapshot, targetId, sourceKey, commit.commitSequence)) {
        if (reduction.changeFeed !== undefined) {
          reduction.previouslyAppliedTarget = true;
          return;
        }
        continue;
      }
      const document = getDocument(definition, reduction, targetId);
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
  return sealProjectionCaptureRequest({
    version: 1, mode: 'atomic-all', projectionName: definition.name, projectionGeneration: generation,
    commit, finalDocuments, stagedLinks: [...reduction.stagedLinks.values()],
    ...(reduction.memberships ? { joinMembershipFences: membershipFences(
      [...reduction.membershipReads].sort().map((key) => reduction.memberships!.get(key)!)) } : {}),
    progress: createProgress(definition, commit, snapshot, targetIds, sourceKey, baselineSequence),
    ...(reduction.validation?.changes ? { validateStateChanges: true } : {}),
    ...(reduction.changeFeed !== undefined ? { additionalWrites: [{
      kind: 'projection_changes',
      collection: reduction.changeFeed,
      targets: finalDocuments.map(({ targetDocumentId, statePatch }) => ({
        targetDocumentId, transitions: statePatch.kind === 'ordered' ? statePatch.transitions : []
      }))
    }] } : {})
  });
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
  projectionChanges?: string,
  validation?: ProjectionStateValidation,
  setRouting?: { memberships: Map<string, ProjectionJoinMembership>; events: readonly (SetRoutingEntry<TState> | null)[] }
): ProjectionReductionResult<TState> {
  if (Boolean(definition.joinMembership) !== Boolean(setRouting)) {
    return { status: 'terminal', reason: 'Set-v1 reduction requires a validated membership snapshot.' };
  }
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
    snapshotTargets: new Map(snapshot.targets.map((target) => [target.targetDocumentId, target])),
    membershipReads: new Set(),
    ...(setRouting ? { memberships: setRouting.memberships, setEvents: setRouting.events } : {}),
    missingTargets: new Set(), missingLinks: new Map(),
    ...(isNativeProjectionCaptureSnapshot(snapshot) ? { nativeSnapshot: snapshot } : {}),
    ...(validation ? { validation } : {}),
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
