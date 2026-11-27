import { joinMembershipKey, type CommitProjectionSourceCommitRequest, type ProjectionSourceCommit,
  type ProjectionSourceCommitSnapshot } from '@redemeine/projection-runtime-core';
import type { ProjectionDefinitionCommitOutcome } from './commitCoordinatorContracts';
import type { JoinSeedInput } from './joinSeedReduction';
import type { JoinSeedTurn } from './joinSeedTurn';
import type { ProjectionDefinitionExecutorOptions } from './projectionDefinitionExecutor';
import { exactReceipt, failed, recordsReliableReceipt } from './projectionDefinitionSnapshot';

export function fencesReadSet<T>(snapshot: ProjectionSourceCommitSnapshot<T>, request: CommitProjectionSourceCommitRequest<T>): boolean {
  if (request.progress.strategy !== 'own_record' || request.progress.source.expectedSequence !== snapshot.ownRecordSequence) return false;
  const documents = new Map(request.finalDocuments.map(({ targetDocumentId, expectedRevision }) => [targetDocumentId, expectedRevision]));
  const memberships = new Map(request.joinMembershipFences?.map((row) =>
    [joinMembershipKey(row.aggregateType, row.aggregateId), row.expectedRevision]));
  // In particular, a rejected absent candidate must not become a placeholder merely to obtain a fence.
  return snapshot.targets.every((row) => documents.get(row.targetDocumentId) === row.revision)
    && snapshot.joinMemberships?.every((row) => memberships.get(joinMembershipKey(row.aggregateType, row.aggregateId)) === row.revision) === true;
}

type ResumeSeedRead =
  | { kind: 'retry_seed_inputs' }
  | { kind: 'refresh_read_set' }
  | { kind: 'done'; outcome: ProjectionDefinitionCommitOutcome };

export async function resumeSeedRead<T>(
  options: ProjectionDefinitionExecutorOptions<T>, commit: ProjectionSourceCommit,
  turn: JoinSeedTurn, inputs: readonly JoinSeedInput[], attempt: number, reused: boolean
): Promise<ResumeSeedRead | undefined> {
  const problem = await turn.load(inputs);
  if (!problem) return;
  if (recordsReliableReceipt(options)) {
    const replay = await exactReceipt(options, commit, attempt);
    if (replay) return { kind: 'done', outcome: replay };
  }
  // An I/O failure needs a new observation because membership may have changed during
  // the wait. Cached failures and prospective limits can only settle against a fresh plan.
  if (problem.phase === 'fresh') return { kind: 'retry_seed_inputs' };
  if (reused) return { kind: 'refresh_read_set' };
  return { kind: 'done', outcome: failed(problem.status, problem.reason, attempt) };
}
