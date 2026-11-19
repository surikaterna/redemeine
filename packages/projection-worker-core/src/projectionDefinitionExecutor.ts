import type {
  ProjectionCommitDefinition,
  ProjectionSourceCommit,
  ProjectionSourceCommitSnapshot,
  ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';
import {
  isCanonicalProjectionUuid,
  matchProjectionChangesReceipt,
  MISSING_PROJECTION_CHANGES_HISTORY,
  projectionChangesIdentity,
  validateProjectionChangeIdentityMetadata
} from '@redemeine/projection-runtime-core';
import type { ProjectionDefinitionCommitOutcome } from './commitCoordinatorContracts';
import { linksByKey, routeEvent, routingLinkRequests } from './projectionCommitRouting';
import { reduceProjectionSourceCommit, type ProjectionReductionResult, type ProjectionStateValidation } from './projectionCommitReducer';
import type { ProjectionLaneScheduler } from './targetLaneScheduler';

export interface ProjectionDefinitionExecutorOptions<TState> {
  definition: ProjectionCommitDefinition<TState>;
  generation: string;
  projectionChanges?: string;
  stateValidation?: ProjectionStateValidation;
  store: ProjectionSourceCommitStorePort<TState>;
  lanes: ProjectionLaneScheduler;
  maxConflictRetries: number;
  stableSingleTarget?: boolean;
  baselineSequence?: number;
  alreadyCovered?: boolean;
}

function laneKey(name: string, generation: string, targetId: string): string {
  return `${name}\u0000${generation}\u0000${targetId}`;
}

function provisionalTargets<TState>(
  definition: ProjectionCommitDefinition<TState>,
  commit: ProjectionSourceCommit,
  snapshot: ProjectionSourceCommitSnapshot<TState>
): readonly string[] {
  const links = linksByKey(snapshot.links);
  const targets = new Set<string>();
  for (const event of commit.events) {
    for (const targetId of routeEvent(definition, event, links)?.targetIds ?? []) targets.add(targetId);
  }
  return [...targets].sort();
}

function failed(
  status: 'conflict' | 'transient' | 'terminal' | 'ambiguous',
  reason: string,
  attempts: number
): ProjectionDefinitionCommitOutcome {
  return status === 'terminal'
    ? { status, retryable: false, reason, attempts }
    : { status, retryable: true, reason, attempts };
}

async function loadSnapshot<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit,
  targets: readonly string[],
  links: readonly { aggregateType: string; aggregateId: string }[],
  mode: 'legacy' | 'turn' | 'discovery' | 'receipt' = 'legacy'
): Promise<ProjectionSourceCommitSnapshot<TState>> {
  const strategy = mode === 'discovery' || mode === 'receipt' ? 'none' : options.definition.deduplication.strategy;
  return options.store.loadProjectionSourceCommitSnapshot({
    projectionName: options.definition.name,
    projectionGeneration: options.generation,
    targetDocumentIds: targets,
    links,
    progressStrategy: strategy,
    ...(strategy === 'own_record' ? { sourceId: commit.streamId } : {}),
    ...(mode === 'turn' ? { prepareSourceCommit: true } : {}),
    ...(mode !== 'discovery' && options.projectionChanges !== undefined && options.definition.deduplication.strategy !== 'none'
      ? { changeIdentity: { sourceId: commit.streamId, commitId: commit.commitId, commitSequence: commit.commitSequence,
          collection: options.projectionChanges } } : {})
  });
}

function replayOutcome<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit,
  snapshot: ProjectionSourceCommitSnapshot<TState>,
  attempts: number,
  deferred = false
): ProjectionDefinitionCommitOutcome | undefined {
  const strategy = options.definition.deduplication.strategy;
  const ownIncludesTurn = strategy === 'own_record' && snapshot.ownRecordSequence !== null && commit.commitSequence <= snapshot.ownRecordSequence;
  if (options.projectionChanges === undefined || strategy === 'none') {
    return ownIncludesTurn ? { status: 'deduplicated', attempts } : undefined;
  }
  if (snapshot.changeReceipt === 'mismatch') {
    return failed('terminal', 'projection change source commit or collection identity mismatch', attempts);
  }
  if (snapshot.changeReceipt === 'committed') return { status: 'deduplicated', attempts };
  if (commit.commitSequence <= (options.baselineSequence ?? -1)) return { status: 'deduplicated', attempts };
  if (snapshot.changeReceipt === undefined && deferred && !ownIncludesTurn && !options.alreadyCovered) return undefined;
  if (snapshot.changeReceipt !== 'missing') return failed('terminal', 'Store did not perform the projection_changes receipt lookup.', attempts);
  if (ownIncludesTurn || options.alreadyCovered) return failed('terminal', MISSING_PROJECTION_CHANGES_HISTORY, attempts);
  return undefined;
}

function hasNativeSnapshots<TState>(options: ProjectionDefinitionExecutorOptions<TState>): boolean {
  return options.store.sourceCommitSnapshotCapability === 'revision-cas-v1';
}

async function checkDeferredReceipt<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>, commit: ProjectionSourceCommit, attempts: number
): Promise<ProjectionDefinitionCommitOutcome | undefined> {
  if (!hasNativeSnapshots(options) || options.projectionChanges === undefined || options.definition.deduplication.strategy === 'none') return;
  try {
    return replayOutcome(options, commit, await loadSnapshot(options, commit, [], [], 'receipt'), attempts);
  } catch (error) {
    return failed('ambiguous', error instanceof Error ? error.message : 'receipt lookup failed', attempts);
  }
}

function mergeLinks(
  current: readonly { aggregateType: string; aggregateId: string }[],
  additions: readonly { aggregateType: string; aggregateId: string }[]
): readonly { aggregateType: string; aggregateId: string }[] {
  const links = new Map(current.map((link) => [`${link.aggregateType}\u0000${link.aggregateId}`, link]));
  for (const link of additions) links.set(`${link.aggregateType}\u0000${link.aggregateId}`, link);
  return [...links.values()];
}

type AttemptResult<TState> =
  | { kind: 'done'; outcome: ProjectionDefinitionCommitOutcome }
  | { kind: 'expand'; reduction: Extract<ProjectionReductionResult<TState>, { status: 'needs_snapshot' }> }
  | { kind: 'conflict'; reason: string };

async function commitReduction<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit,
  reduction: Extract<ProjectionReductionResult<TState>, { status: 'planned' }>,
  attempt: number,
  snapshot?: ProjectionSourceCommitSnapshot<TState>
): Promise<AttemptResult<TState>> {
  try {
    const result = snapshot ? await options.store.commitProjectionSourceCommit(reduction.request, snapshot)
      : await options.store.commitProjectionSourceCommit(reduction.request);
    if (result.status === 'committed') {
      const append = reduction.request.additionalWrites?.[0];
      const identity = projectionChangesIdentity(reduction.request);
      const receipt = result.additionalWrites?.[0] ?? result.emptyChangeReceipt;
      const applicationId = reduction.request.progress.strategy === 'none' ? receipt?.applicationId : undefined;
      if (identity && (!receipt || (reduction.request.progress.strategy === 'none' && !isCanonicalProjectionUuid(applicationId))
        || matchProjectionChangesReceipt(identity, receipt, applicationId) === 'mismatch'
        || (append?.targets.length && receipt.kind !== 'projection_changes'))) {
        return { kind: 'done', outcome: failed('terminal', 'Store did not return a matching projection_changes receipt.', attempt) };
      }
      const outcome = result.commitSequence === commit.commitSequence
        ? { status: result.replayed ? 'deduplicated' as const : 'committed' as const, attempts: attempt }
        : failed('terminal', 'Store returned a mismatched commit sequence.', attempt);
      return { kind: 'done', outcome };
    }
    if (!result.retryable) return { kind: 'done', outcome: failed('terminal', result.reason, attempt) };
    return result.category === 'conflict'
      ? { kind: 'conflict', reason: result.reason }
      : { kind: 'done', outcome: failed(result.category, result.reason, attempt) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'commit outcome unknown';
    return { kind: 'done', outcome: failed('ambiguous', reason, attempt) };
  }
}

async function executeAttempt<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit,
  targets: ReadonlySet<string>,
  links: readonly { aggregateType: string; aggregateId: string }[],
  attempt: number
): Promise<AttemptResult<TState>> {
  const keys = [...targets].map((target) => laneKey(options.definition.name, options.generation, target));
  return options.lanes.run(keys, async () => {
    const native = hasNativeSnapshots(options);
    let snapshot: ProjectionSourceCommitSnapshot<TState>;
    try {
      snapshot = await loadSnapshot(options, commit, [...targets].sort(), links, native ? 'turn' : 'legacy');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'snapshot load failed';
      return { kind: 'done', outcome: await checkDeferredReceipt(options, commit, attempt)
        ?? failed(reason.startsWith('Detected legacy writer') ? 'terminal' : 'ambiguous', reason, attempt) };
    }
    const replay = replayOutcome(options, commit, snapshot, attempt, native);
    if (replay) return { kind: 'done', outcome: replay };
    const reduction = reduceProjectionSourceCommit(
      options.definition, options.generation, commit, snapshot, options.baselineSequence, options.projectionChanges, options.stateValidation
    );
    if (reduction.status === 'needs_snapshot') return { kind: 'expand', reduction };
    if (reduction.status === 'terminal') {
      const receipt = snapshot.changeReceipt === undefined ? await checkDeferredReceipt(options, commit, attempt) : undefined;
      return { kind: 'done', outcome: receipt ?? failed('terminal', reduction.reason, attempt) };
    }
    if (reduction.status === 'deduplicated') {
      return { kind: 'done', outcome: { status: 'deduplicated', attempts: attempt } };
    }
    if (options.stableSingleTarget && (reduction.request.finalDocuments.length > 1
      || reduction.request.stagedLinks.length > 0)) {
      return { kind: 'done', outcome: await checkDeferredReceipt(options, commit, attempt)
        ?? failed('terminal', 'Legacy in-document cutover forbids fanout or link mutation.', attempt) };
    }
    return commitReduction(options, commit, reduction, attempt, native ? snapshot : undefined);
  });
}

export async function executeProjectionDefinition<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit
): Promise<ProjectionDefinitionCommitOutcome> {
  if (options.projectionChanges !== undefined && options.store.projectionChangesCapability !== 'atomic-turn-receipts-v1') {
    return failed('terminal', 'Store does not support atomic projection_changes turn receipts.', 0);
  }
  if (options.projectionChanges !== undefined) {
    const invalid = validateProjectionChangeIdentityMetadata({
      projectionName: options.definition.name, projectionGeneration: options.generation,
      collection: options.projectionChanges, sourceId: commit.streamId,
      commitId: commit.commitId, commitSequence: commit.commitSequence
    });
    if (invalid) return failed('terminal', invalid, 0);
  }
  let links = routingLinkRequests(options.definition, commit.events);
  const native = hasNativeSnapshots(options);
  const lookupEarly = options.projectionChanges !== undefined && options.definition.deduplication.strategy !== 'none'
    && (options.alreadyCovered || commit.commitSequence <= (options.baselineSequence ?? -1));
  let initial: ProjectionSourceCommitSnapshot<TState> = { targets: [], links: [], ownRecordSequence: null };
  try {
    if (!native) initial = await loadSnapshot(options, commit, [], links);
    else if (lookupEarly) initial = await loadSnapshot(options, commit, [], [], 'receipt');
    else if (links.length) initial = await loadSnapshot(options, commit, [], links, 'discovery');
  } catch (error) {
    return failed('ambiguous', error instanceof Error ? error.message : 'snapshot load failed', 0);
  }
  const replay = replayOutcome(options, commit, initial, 0, native && !lookupEarly);
  if (replay) return replay;
  let routedTargets: readonly string[];
  try {
    routedTargets = provisionalTargets(options.definition, commit, initial);
  } catch (error) {
    return await checkDeferredReceipt(options, commit, 0)
      ?? failed('terminal', error instanceof Error ? error.message : 'projection routing failed', 0);
  }
  const targets = new Set(routedTargets);
  const maxAttempts = options.maxConflictRetries + (commit.events.length * 2) + 2;
  let conflicts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = await executeAttempt(options, commit, targets, links, attempt);
    if (outcome.kind === 'done') return outcome.outcome;
    if (outcome.kind === 'expand') {
      for (const target of outcome.reduction.targetIds) targets.add(target);
      links = mergeLinks(links, outcome.reduction.links);
      continue;
    }
    conflicts += 1;
    if (conflicts > options.maxConflictRetries) return failed('conflict', outcome.reason, attempt);
  }
  return failed('conflict', 'projection retry limit exhausted', options.maxConflictRetries + 1);
}
