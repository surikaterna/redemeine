import type {
  ProjectionCommitDefinition,
  ProjectionSourceCommit,
  ProjectionSourceCommitSnapshot,
  ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';
import type { ProjectionDefinitionCommitOutcome } from './commitCoordinatorContracts';
import { linksByKey, routeEvent, routingLinkRequests } from './projectionCommitRouting';
import { reduceProjectionSourceCommit } from './projectionCommitReducer';
import type { ProjectionLaneScheduler } from './targetLaneScheduler';

export interface ProjectionDefinitionExecutorOptions<TState> {
  definition: ProjectionCommitDefinition<TState>;
  generation: string;
  store: ProjectionSourceCommitStorePort<TState>;
  lanes: ProjectionLaneScheduler;
  maxConflictRetries: number;
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
    const keys = [...targets].map((target) => laneKey(options.definition.name, options.generation, target));
    const outcome = await options.lanes.run(keys, async () => {
      let snapshot: ProjectionSourceCommitSnapshot<TState>;
      try {
        snapshot = await loadAttempt(options, commit, [...targets].sort(), links);
      } catch (error) {
        return { kind: 'done' as const, outcome: failed('ambiguous', error instanceof Error ? error.message : 'snapshot load failed', attempt) };
      }
      const reduction = reduceProjectionSourceCommit(options.definition, options.generation, commit, snapshot);
      if (reduction.status === 'needs_snapshot') return { kind: 'expand' as const, reduction };
      if (reduction.status === 'terminal') return { kind: 'done' as const, outcome: failed('terminal', reduction.reason, attempt) };
      if (reduction.status === 'deduplicated') return { kind: 'done' as const, outcome: { status: 'deduplicated' as const, attempts: attempt } };
      try {
        const result = await options.store.commitProjectionSourceCommit(reduction.request);
        if (result.status === 'committed') {
          const outcome = result.commitSequence === commit.commitSequence
            ? { status: 'committed' as const, attempts: attempt }
            : failed('terminal', 'Store returned a mismatched commit sequence.', attempt);
          return { kind: 'done' as const, outcome };
        }
        if (!result.retryable) return { kind: 'done' as const, outcome: failed('terminal', result.reason, attempt) };
        return result.category === 'conflict'
          ? { kind: 'conflict' as const, reason: result.reason }
          : { kind: 'done' as const, outcome: failed(result.category, result.reason, attempt) };
      } catch (error) {
        return { kind: 'done' as const, outcome: failed('ambiguous', error instanceof Error ? error.message : 'commit outcome unknown', attempt) };
      }
    });
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
