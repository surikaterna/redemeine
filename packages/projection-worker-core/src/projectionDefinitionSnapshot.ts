import {
  MISSING_PROJECTION_CHANGES_HISTORY, ProjectionJoinMembershipValidationError, ProjectionPersistedJoinMembershipError,
  type ProjectionSourceCommit, type ProjectionSourceCommitSnapshot
} from '@redemeine/projection-runtime-core';
import type { ProjectionDefinitionCommitOutcome } from './commitCoordinatorContracts';
import type { ProjectionDefinitionExecutorOptions } from './projectionDefinitionExecutor';

export function failed(
  status: 'conflict' | 'transient' | 'terminal' | 'ambiguous',
  reason: string,
  attempts: number
): ProjectionDefinitionCommitOutcome {
  return status === 'terminal'
    ? { status, retryable: false, reason, attempts }
    : { status, retryable: true, reason, attempts };
}

export function loadFailure(error: unknown, attempts: number): ProjectionDefinitionCommitOutcome {
  const reason = error instanceof Error ? error.message : 'snapshot load failed';
  return failed(error instanceof ProjectionJoinMembershipValidationError || reason.startsWith('Detected legacy writer')
    ? 'terminal' : 'transient', reason, attempts);
}

export async function loadSnapshot<TState>(
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
    ...(options.definition.joinMembership && mode !== 'receipt' ? { joinMembership: options.definition.joinMembership } : {}),
    ...(options.definition.joinInitializers?.length && mode !== 'receipt' ? { joinSeedVersion: 1 } : {}),
    progressStrategy: strategy,
    ...(strategy === 'own_record' ? { sourceId: commit.streamId } : {}),
    ...(mode === 'turn' ? { prepareSourceCommit: true } : {}),
    ...(mode !== 'discovery' && options.projectionChanges !== undefined && options.definition.deduplication.strategy !== 'none'
      ? { changeIdentity: { sourceId: commit.streamId, commitId: commit.commitId, commitSequence: commit.commitSequence,
          collection: options.projectionChanges } } : {})
  });
}

export function hasNativeSnapshots<TState>(options: ProjectionDefinitionExecutorOptions<TState>): boolean {
  return options.store.sourceCommitSnapshotCapability === 'revision-cas-v1';
}

export function recordsReliableReceipt<TState>(options: ProjectionDefinitionExecutorOptions<TState>): boolean {
  return options.projectionChanges !== undefined && options.definition.deduplication.strategy !== 'none';
}

const receiptMismatch = 'projection change source commit or collection identity mismatch';

export function replayOutcome<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit,
  snapshot: ProjectionSourceCommitSnapshot<TState>,
  attempts: number,
  deferred = false
): ProjectionDefinitionCommitOutcome | undefined {
  const strategy = options.definition.deduplication.strategy;
  const ownIncludesTurn = strategy === 'own_record' && snapshot.ownRecordSequence !== null && commit.commitSequence <= snapshot.ownRecordSequence;
  if (!recordsReliableReceipt(options)) return ownIncludesTurn ? { status: 'deduplicated', attempts } : undefined;
  if (snapshot.changeReceipt === 'mismatch') return failed('terminal', receiptMismatch, attempts);
  if (snapshot.changeReceipt === 'committed') return { status: 'deduplicated', attempts };
  if (commit.commitSequence <= (options.baselineSequence ?? -1)) return { status: 'deduplicated', attempts };
  if (snapshot.changeReceipt === undefined && deferred && !ownIncludesTurn && !options.alreadyCovered) return undefined;
  if (snapshot.changeReceipt !== 'missing') return failed('terminal', 'Store did not perform the projection_changes receipt lookup.', attempts);
  if (ownIncludesTurn || options.alreadyCovered) return failed('terminal', MISSING_PROJECTION_CHANGES_HISTORY, attempts);
  return undefined;
}

export async function checkDeferredReceipt<TState>(
  options: ProjectionDefinitionExecutorOptions<TState>, commit: ProjectionSourceCommit, attempts: number
): Promise<ProjectionDefinitionCommitOutcome | undefined> {
  if (!hasNativeSnapshots(options) || !recordsReliableReceipt(options)) return;
  try {
    return replayOutcome(options, commit, await loadSnapshot(options, commit, [], [], 'receipt'), attempts);
  } catch (error) {
    return failed('ambiguous', error instanceof Error ? error.message : 'receipt lookup failed', attempts);
  }
}

export async function exactReceipt<TState>(options: ProjectionDefinitionExecutorOptions<TState>, commit: ProjectionSourceCommit,
  attempts: number): Promise<ProjectionDefinitionCommitOutcome | undefined> {
  try {
    const proof = (await loadSnapshot(options, commit, [], [], 'receipt')).changeReceipt;
    if (proof === 'committed') return { status: 'deduplicated', attempts };
    if (proof === 'missing') return undefined;
    if (proof === 'mismatch') return failed('terminal', receiptMismatch, attempts);
    return failed('ambiguous', 'Store did not verify the projection_changes receipt.', attempts);
  } catch (error) {
    return failed('ambiguous', error instanceof Error ? error.message : 'receipt lookup failed', attempts);
  }
}

export async function resolveMembershipReadFailure<TState>(options: ProjectionDefinitionExecutorOptions<TState>,
  commit: ProjectionSourceCommit, error: ProjectionJoinMembershipValidationError, attempts: number): Promise<ProjectionDefinitionCommitOutcome> {
  const failure = loadFailure(error, attempts);
  if (!(error instanceof ProjectionPersistedJoinMembershipError) || !recordsReliableReceipt(options)) return failure;
  return await exactReceipt(options, commit, attempts) ?? failure;
}
