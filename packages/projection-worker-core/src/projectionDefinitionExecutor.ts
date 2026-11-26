import type {
  CommitProjectionSourceCommitCommitted,
  CommitProjectionSourceCommitRequest,
  ProjectionChangesReceipt,
  ProjectionSourceCommit,
  ProjectionSourceCommitSnapshot,
  ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';
import {
  isCanonicalProjectionUuid,
  checkedJoinMembershipKey,
  JOIN_MEMBERSHIP_FENCE_CAPACITY,
  ProjectionJoinCapacityError,
  ProjectionJoinMembershipValidationError,
  JoinTurnBudget,
  joinMembershipKey,
  matchProjectionChangesReceipt,
  projectionChangesIdentity,
  validateProjectionChangeIdentityMetadata
} from '@redemeine/projection-runtime-core';
import type { ProjectionCommitDefinitionInput as ProjectionCommitDefinition, ProjectionDefinitionCommitOutcome } from './commitCoordinatorContracts';
import { linksByKey, planSetRouting, routeEvent, routingLinkRequests, type SetRoutingEntry } from './projectionCommitRouting';
import { reduceProjectionSourceCommit, type ProjectionReductionResult, type ProjectionStateValidation } from './projectionCommitReducer';
import type { ProjectionLaneScheduler } from './targetLaneScheduler';
import { collectSetTargets, observedMemberships } from './joinMembershipReduction';
import {
  checkDeferredReceipt, exactReceipt, failed, hasNativeSnapshots, loadFailure, loadSnapshot,
  recordsReliableReceipt, replayOutcome, resolveMembershipReadFailure
} from './projectionDefinitionSnapshot';

type SetPlan<T> = readonly (SetRoutingEntry<T> | null)[];

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

async function capacityRejection<TState>(options: ProjectionDefinitionExecutorOptions<TState>, commit: ProjectionSourceCommit,
  reason: string, attempt: number, confirmed: boolean): Promise<CapacityResult> {
  if (!recordsReliableReceipt(options)) return { kind: 'done', outcome: failed('terminal', reason, attempt) };
  const outcome = await exactReceipt(options, commit, attempt);
  if (outcome) return { kind: 'done', outcome };
  // Missing proof says nothing about whether the observation that overflowed is still current.
  if (!confirmed) return { kind: 'confirm_capacity' };
  return { kind: 'done', outcome: failed('terminal', reason, attempt) };
}

function mergeLinks(
  current: readonly { aggregateType: string; aggregateId: string }[],
  additions: readonly { aggregateType: string; aggregateId: string }[],
  setMode: boolean
): readonly { aggregateType: string; aggregateId: string }[] {
  const key = ({ aggregateType, aggregateId }: typeof current[number]) => setMode
    ? joinMembershipKey(aggregateType, aggregateId) : `${aggregateType}\u0000${aggregateId}`;
  const links = new Map(current.map((link) => [key(link), link]));
  for (const link of additions) links.set(key(link), link);
  return [...links.values()];
}

function setMemberships<TState>(snapshot: ProjectionSourceCommitSnapshot<TState>,
  links: readonly { aggregateType: string; aggregateId: string }[]) {
  if (snapshot.links.length) throw new Error('Mixed scalar and set membership snapshot.');
  return observedMemberships(snapshot.joinMemberships, links);
}

function checkLinkBudget(links: readonly { aggregateType: string; aggregateId: string }[]) {
  const budget = new JoinTurnBudget();
  for (const link of links) budget.add(checkedJoinMembershipKey(link.aggregateType, link.aggregateId));
}

type CapacityResult =
  | { kind: 'done'; outcome: ProjectionDefinitionCommitOutcome }
  | { kind: 'confirm_capacity' };

type AttemptResult<TState> =
  | CapacityResult
  | { kind: 'expand'; reduction: Extract<ProjectionReductionResult<TState>, { status: 'needs_snapshot' }> }
  | { kind: 'retarget'; targets: Set<string> }
  | { kind: 'conflict'; reason: string };

function matchesReceiptTargets(receipt: ProjectionChangesReceipt, request: CommitProjectionSourceCommitRequest): boolean {
  const documents = request.finalDocuments;
  if (receipt.kind === 'projection_changes_empty') return documents.length === 0;
  if (receipt.targets.length !== documents.length) return false;
  const expected = new Set(documents.map(({ targetDocumentId }) => targetDocumentId));
  return receipt.targets.every(({ targetDocumentId }) => expected.has(targetDocumentId));
}

function hasMatchingCommitReceipt(request: CommitProjectionSourceCommitRequest, result: CommitProjectionSourceCommitCommitted): boolean {
  const identity = projectionChangesIdentity(request);
  if (!identity) return true;
  const writes = result.additionalWrites;
  const empty = result.emptyChangeReceipt;
  if (writes !== undefined && (empty !== undefined || !Array.isArray(writes)
    || writes.length !== 1 || writes[0]?.kind !== 'projection_changes')) return false;
  if (empty !== undefined && empty?.kind !== 'projection_changes_empty') return false;
  const receipt = writes?.[0] ?? empty;
  if (!receipt) return false;
  const reliable = request.progress.strategy !== 'none';
  const applicationId = reliable ? undefined : receipt.applicationId;
  if (!reliable && !isCanonicalProjectionUuid(applicationId)) return false;
  // A canonical replay can describe an earlier plan, not the losing attempt's target set.
  return matchProjectionChangesReceipt(identity, receipt, applicationId) === 'committed'
    && (result.replayed === true || matchesReceiptTargets(receipt, request));
}

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
      if ((result.replayed !== undefined && typeof result.replayed !== 'boolean')
        || (result.replayed === true && reduction.request.progress.strategy === 'none')) {
        return { kind: 'done', outcome: failed('terminal', 'Store returned an invalid commit replay flag.', attempt) };
      }
      if (!hasMatchingCommitReceipt(reduction.request, result)) {
        return { kind: 'done', outcome: failed('terminal', 'Store did not return a matching projection_changes receipt.', attempt) };
      }
      const outcome = result.commitSequence === commit.commitSequence
        ? { status: result.replayed === true ? 'deduplicated' as const : 'committed' as const, attempts: attempt }
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
  attempt: number,
  setPlan: SetPlan<TState> | undefined,
  confirmCapacity: boolean
): Promise<AttemptResult<TState>> {
  const keys = [...targets].map((target) => laneKey(options.definition.name, options.generation, target));
  return options.lanes.run(keys, async () => {
    const native = hasNativeSnapshots(options) && !confirmCapacity;
    let snapshot: ProjectionSourceCommitSnapshot<TState>;
    try {
      snapshot = await loadSnapshot(options, commit, [...targets].sort(), links, native ? 'turn' : 'legacy');
    } catch (error) {
      if (error instanceof ProjectionJoinCapacityError) return capacityRejection(options, commit, error.message, attempt, confirmCapacity);
      if (error instanceof ProjectionJoinMembershipValidationError) {
        return { kind: 'done', outcome: await resolveMembershipReadFailure(options, commit, error, attempt) };
      }
      return { kind: 'done', outcome: await checkDeferredReceipt(options, commit, attempt)
        ?? loadFailure(error, attempt) };
    }
    if (confirmCapacity && snapshot.changeReceipt === undefined) {
      return { kind: 'done', outcome: failed('ambiguous', 'Store did not verify the projection_changes receipt.', attempt) };
    }
    const replay = replayOutcome(options, commit, snapshot, attempt, native);
    if (replay) return { kind: 'done', outcome: replay };
    return reduceAttempt(options, commit, snapshot, targets, links, attempt, setPlan, confirmCapacity, native);
  });
}

async function reduceAttempt<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>, commit: ProjectionSourceCommit,
  snapshot: ProjectionSourceCommitSnapshot<TState>, targets: ReadonlySet<string>, links: ReturnType<typeof routingLinkRequests>,
  attempt: number, setPlan: SetPlan<TState> | undefined, confirmCapacity: boolean, native: boolean
): Promise<AttemptResult<TState>> {
  let reduction: ProjectionReductionResult<TState>;
  try {
    const memberships = setPlan ? setMemberships(snapshot, links) : undefined;
    if (setPlan && memberships) {
      const currentTargets = collectSetTargets(setPlan, memberships);
      if ([...currentTargets].some((id) => !targets.has(id))) return { kind: 'retarget', targets: currentTargets };
    }
    reduction = reduceProjectionSourceCommit(options.definition, options.generation, commit, snapshot, options.baselineSequence,
      options.projectionChanges, options.stateValidation, setPlan && memberships ? { events: setPlan, memberships } : undefined);
  } catch (error) {
    if (error instanceof ProjectionJoinCapacityError) return capacityRejection(options, commit, error.message, attempt, confirmCapacity);
    if (error instanceof ProjectionJoinMembershipValidationError) {
      return { kind: 'done', outcome: await resolveMembershipReadFailure(options, commit, error, attempt) };
    }
    return { kind: 'done', outcome: failed('terminal', error instanceof Error ? error.message : 'Invalid membership snapshot.', attempt) };
  }
  if (reduction.status === 'needs_snapshot') return { kind: 'expand', reduction };
  if (reduction.status === 'membership_capacity') return capacityRejection(options, commit, reduction.reason, attempt, confirmCapacity);
  if (reduction.status === 'terminal') {
    const receipt = !reduction.invalidMembershipInput && snapshot.changeReceipt === undefined
      ? await checkDeferredReceipt(options, commit, attempt) : undefined;
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
  const result = await commitReduction(options, commit, reduction, attempt, native ? snapshot : undefined);
  if (setPlan && result.kind === 'done' && result.outcome.status === 'terminal' && result.outcome.reason === JOIN_MEMBERSHIP_FENCE_CAPACITY) {
    return capacityRejection(options, commit, result.outcome.reason, attempt, confirmCapacity);
  }
  return result;
}

function validateDefinitionTurn<TState>(options: ProjectionDefinitionExecutorOptions<TState>, commit: ProjectionSourceCommit) {
  if (options.projectionChanges !== undefined && options.store.projectionChangesCapability !== 'atomic-turn-receipts-v1') {
    return failed('terminal', 'Store does not support atomic projection_changes turn receipts.', 0);
  }
  const setMode = options.definition.joinMembership === 'set-v1';
  if (setMode && (options.store.joinMembershipCapability !== 'set-v1' || options.definition.deduplication.strategy === 'in_document')) {
    return failed('terminal', 'Join membership sets require a capable store and own_record or none.', 0);
  }
  if (options.projectionChanges !== undefined) {
    const invalid = validateProjectionChangeIdentityMetadata({
      projectionName: options.definition.name, projectionGeneration: options.generation,
      collection: options.projectionChanges, sourceId: commit.streamId,
      commitId: commit.commitId, commitSequence: commit.commitSequence
    });
    if (invalid) return failed('terminal', invalid, 0);
  }
}

export async function executeProjectionDefinition<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit
): Promise<ProjectionDefinitionCommitOutcome> {
  const invalid = validateDefinitionTurn(options, commit);
  if (invalid) return invalid;
  const setMode = options.definition.joinMembership === 'set-v1';
  const links = routingLinkRequests(options.definition, commit.events);
  const native = hasNativeSnapshots(options);
  const lookupEarly = recordsReliableReceipt(options)
    && (options.alreadyCovered || commit.commitSequence <= (options.baselineSequence ?? -1));
  let initial: ProjectionSourceCommitSnapshot<TState> = { targets: [], links: [], ownRecordSequence: null };
  let confirmCapacity = false;
  try { if (setMode) checkLinkBudget(links); } catch (error) {
    return failed('terminal', (error as Error).message, 0);
  }
  try {
    if (!native) initial = await loadSnapshot(options, commit, [], links);
    else if (lookupEarly) initial = await loadSnapshot(options, commit, [], [], 'receipt');
    else if (setMode) initial = await loadSnapshot(options, commit, [], links, 'turn');
    else if (links.length) initial = await loadSnapshot(options, commit, [], links, 'discovery');
  } catch (error) {
    if (error instanceof ProjectionJoinCapacityError) {
      const result = await capacityRejection(options, commit, error.message, 0, false);
      if (result.kind === 'done') return result.outcome;
      confirmCapacity = true;
    } else {
      if (error instanceof ProjectionJoinMembershipValidationError) return resolveMembershipReadFailure(options, commit, error, 0);
      return loadFailure(error, 0);
    }
  }
  const replay = confirmCapacity ? undefined : replayOutcome(options, commit, initial, 0, native && !lookupEarly);
  if (replay) return replay;
  let setPlan: SetPlan<TState> | undefined;
  let targets = new Set<string>();
  try {
    setPlan = setMode ? planSetRouting(options.definition, commit.events) : undefined;
    if (!confirmCapacity) targets = setPlan ? collectSetTargets(setPlan, setMemberships(initial, links))
      : new Set(provisionalTargets(options.definition, commit, initial));
  } catch (error) {
    if (setPlan && error instanceof ProjectionJoinCapacityError) {
      const result = await capacityRejection(options, commit, error.message, 0, false);
      if (result.kind === 'done') return result.outcome;
      confirmCapacity = true;
    } else {
      if (error instanceof ProjectionJoinMembershipValidationError) return resolveMembershipReadFailure(options, commit, error, 0);
      return await checkDeferredReceipt(options, commit, 0)
        ?? failed('terminal', error instanceof Error ? error.message : 'projection routing failed', 0);
    }
  }
  return executeWithRetries(options, commit, targets, links, setPlan, confirmCapacity);
}

async function executeWithRetries<TState>(options: ProjectionDefinitionExecutorOptions<TState>, commit: ProjectionSourceCommit,
  targets: Set<string>, initialLinks: ReturnType<typeof routingLinkRequests>, setPlan: SetPlan<TState> | undefined,
  confirmCapacity: boolean): Promise<ProjectionDefinitionCommitOutcome> {
  let links = initialLinks;
  const expansionBudget = (commit.events.length * 2) + 2;
  let maxAttempts = options.maxConflictRetries + expansionBudget;
  let conflicts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let outcome = await executeAttempt(options, commit, targets, links, attempt, setPlan, confirmCapacity);
    if (outcome.kind === 'retarget') {
      targets = outcome.targets;
      continue;
    }
    if (outcome.kind === 'expand') {
      const nextLinks = mergeLinks(links, outcome.reduction.links, Boolean(setPlan));
      try {
        if (setPlan) checkLinkBudget(nextLinks);
        links = nextLinks;
        for (const target of outcome.reduction.targetIds) targets.add(target);
        continue;
      } catch (error) {
        if (!(error instanceof ProjectionJoinCapacityError)) return loadFailure(error, attempt);
        outcome = await capacityRejection(options, commit, error.message, attempt, confirmCapacity);
      }
    }
    if (outcome.kind === 'done') return outcome.outcome;
    if (outcome.kind === 'confirm_capacity') {
      confirmCapacity = true;
      maxAttempts += expansionBudget;
      targets.clear();
      links = initialLinks;
      continue;
    }
    conflicts += 1;
    if (conflicts > options.maxConflictRetries) return failed('conflict', outcome.reason, attempt);
  }
  return failed('conflict', 'projection retry limit exhausted', options.maxConflictRetries + 1);
}
