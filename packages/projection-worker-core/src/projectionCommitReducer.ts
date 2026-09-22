import type {
  CommitProjectionSourceCommitRequest,
  ProjectionCommitDefinition,
  ProjectionContext,
  ProjectionSourceCommit,
  ProjectionSourceCommitLink,
  ProjectionSourceCommitSnapshot,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import { projectionUuidToBase64Url22 } from '@redemeine/projection-runtime-core';
import { linksByKey, routeEvent, type RoutingLinkState } from './projectionCommitRouting';

export type ProjectionReductionResult<TState> =
  | { status: 'planned'; request: CommitProjectionSourceCommitRequest<TState> }
  | { status: 'deduplicated' }
  | { status: 'needs_snapshot'; targetIds: readonly string[]; links: readonly { aggregateType: string; aggregateId: string }[] }
  | { status: 'terminal'; reason: string };

interface ReductionState<TState> {
  documents: Map<string, { state: TState; revision: number | null }>;
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
): { state: TState; revision: number | null } | null {
  const existing = reduction.documents.get(targetId);
  if (existing) return existing;
  const target = snapshot.targets.find((candidate) => candidate.targetDocumentId === targetId);
  if (!target) {
    reduction.missingTargets.add(targetId);
    return null;
  }
  const document = {
    state: target.state === null ? definition.initialState(targetId) : clone(target.state),
    revision: target.revision
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
  sourceKey: ProjectionUuidBase64Url22
): CommitProjectionSourceCommitRequest<TState>['progress'] {
  const strategy = definition.deduplication;
  if (strategy.strategy === 'none') return { strategy: 'none' };
  if (strategy.strategy === 'own_record') {
    return {
      strategy: 'own_record',
      source: { sourceId: commit.streamId, expectedSequence: snapshot.ownRecordSequence, finalSequence: commit.commitSequence },
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

export function reduceProjectionSourceCommit<TState>(
  definition: ProjectionCommitDefinition<TState>,
  generation: string,
  commit: ProjectionSourceCommit,
  snapshot: ProjectionSourceCommitSnapshot<TState>
): ProjectionReductionResult<TState> {
  if (definition.deduplication.strategy === 'own_record'
    && snapshot.ownRecordSequence !== null
    && commit.commitSequence <= snapshot.ownRecordSequence) return { status: 'deduplicated' };
  const sourceKey = projectionUuidToBase64Url22(commit.streamId);
  const reduction: ReductionState<TState> = {
    documents: new Map(), touched: new Set(), links: linksByKey(snapshot.links), stagedLinks: new Map(),
    missingTargets: new Set(), missingLinks: new Map()
  };
  try {
    for (const sourceEvent of commit.events) {
      const routed = routeEvent(definition, sourceEvent, reduction.links);
      if (!routed) continue;
      for (const targetId of routed.targetIds) {
        if (!canApplyToTarget(definition, snapshot, targetId, sourceKey, commit.commitSequence)) continue;
        if (sourceEvent.aggregateType !== definition.fromStream.aggregate.aggregateType) {
          stageLink(reduction, 'subscribe', sourceEvent.aggregateType, sourceEvent.aggregateId, targetId);
        }
        const document = getDocument(definition, snapshot, reduction, targetId);
        if (!document) continue;
        routed.handler(document.state as never, routed.event, createContext(reduction, targetId));
        definition.hooks?.afterEach?.(document.state, routed.event);
        reduction.touched.add(targetId);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'projection handler threw';
    return { status: 'terminal', reason };
  }
  const missing = needsSnapshot(reduction);
  if (missing) return missing;
  if (definition.deduplication.strategy === 'in_document'
    && reduction.touched.size === 0
    && commit.events.some((event) => routeEvent(definition, event, reduction.links)?.targetIds.length)) {
    return { status: 'deduplicated' };
  }
  const targetIds = [...reduction.touched].sort();
  return {
    status: 'planned',
    request: {
      version: 1,
      mode: 'atomic-all',
      projectionName: definition.name,
      projectionGeneration: generation,
      commit,
      finalDocuments: targetIds.map((targetDocumentId) => {
        const document = reduction.documents.get(targetDocumentId) as { state: TState; revision: number | null };
        return { targetDocumentId, expectedRevision: document.revision, finalDocument: document.state };
      }),
      stagedLinks: [...reduction.stagedLinks.values()],
      progress: createProgress(definition, commit, snapshot, targetIds, sourceKey)
    }
  };
}
