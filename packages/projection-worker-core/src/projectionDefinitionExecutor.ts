import type {
  ProjectionCommitDefinition,
  ProjectionSourceCommit,
  ProjectionSourceCommitSnapshot,
  ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';
import type { ProjectionDefinitionCommitOutcome } from './commitCoordinatorContracts';
import { linksByKey, routeEvent, routingLinkRequests } from './projectionCommitRouting';
import { reduceProjectionSourceCommit, type ProjectionReductionResult } from './projectionCommitReducer';
import type { ProjectionLaneScheduler } from './targetLaneScheduler';

export interface ProjectionDefinitionExecutorOptions<TState> {
  definition: ProjectionCommitDefinition<TState>;
  generation: string;
  store: ProjectionSourceCommitStorePort<TState>;
  lanes: ProjectionLaneScheduler;
  maxConflictRetries: number;
  stableSingleTarget?: boolean;
  baselineSequence?: number;
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

async function loadInitial<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit,
  links: readonly { aggregateType: string; aggregateId: string }[]
): Promise<ProjectionSourceCommitSnapshot<TState>> {
  return options.store.loadProjectionSourceCommitSnapshot({
    projectionName: options.definition.name,
    projectionGeneration: options.generation,
    targetDocumentIds: [],
    links,
    progressStrategy: options.definition.deduplication.strategy,
    ...(options.definition.deduplication.strategy === 'own_record' ? { sourceId: commit.streamId } : {})
  });
}

async function loadAttempt<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit,
  targets: readonly string[],
  links: readonly { aggregateType: string; aggregateId: string }[]
): Promise<ProjectionSourceCommitSnapshot<TState>> {
  return options.store.loadProjectionSourceCommitSnapshot({
    projectionName: options.definition.name,
    projectionGeneration: options.generation,
    targetDocumentIds: targets,
    links,
    progressStrategy: options.definition.deduplication.strategy,
    ...(options.definition.deduplication.strategy === 'own_record' ? { sourceId: commit.streamId } : {})
  });
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
  attempt: number
): Promise<AttemptResult<TState>> {
  try {
    const result = await options.store.commitProjectionSourceCommit(reduction.request);
    if (result.status === 'committed') {
      const outcome = result.commitSequence === commit.commitSequence
        ? { status: 'committed' as const, attempts: attempt }
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
    let snapshot: ProjectionSourceCommitSnapshot<TState>;
    try {
      snapshot = await loadAttempt(options, commit, [...targets].sort(), links);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'snapshot load failed';
      return { kind: 'done', outcome: failed(reason.startsWith('Detected legacy writer') ? 'terminal' : 'ambiguous', reason, attempt) };
    }
    const reduction = reduceProjectionSourceCommit(options.definition, options.generation, commit, snapshot, options.baselineSequence);
    if (reduction.status === 'needs_snapshot') return { kind: 'expand', reduction };
    if (reduction.status === 'terminal') return { kind: 'done', outcome: failed('terminal', reduction.reason, attempt) };
    if (reduction.status === 'deduplicated') {
      return { kind: 'done', outcome: { status: 'deduplicated', attempts: attempt } };
    }
    if (options.stableSingleTarget && (reduction.request.finalDocuments.length > 1
      || reduction.request.stagedLinks.length > 0)) {
      return { kind: 'done', outcome: failed('terminal', 'Legacy in-document cutover forbids fanout or link mutation.', attempt) };
    }
    return commitReduction(options, commit, reduction, attempt);
  });
}

export async function executeProjectionDefinition<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit
): Promise<ProjectionDefinitionCommitOutcome> {
  let links = routingLinkRequests(options.definition, commit.events);
  let initial: ProjectionSourceCommitSnapshot<TState>;
  try {
    initial = await loadInitial(options, commit, links);
  } catch (error) {
    return failed('ambiguous', error instanceof Error ? error.message : 'snapshot load failed', 0);
  }
  if (options.definition.deduplication.strategy === 'own_record'
    && initial.ownRecordSequence !== null
    && commit.commitSequence <= initial.ownRecordSequence) return { status: 'deduplicated', attempts: 0 };
  let routedTargets: readonly string[];
  try {
    routedTargets = provisionalTargets(options.definition, commit, initial);
  } catch (error) {
    return failed('terminal', error instanceof Error ? error.message : 'projection routing failed', 0);
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
