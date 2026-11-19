import { equalProjectionChangeJson, isPortableProjectionChangeJson } from './projectionChangeJson';
import { isSealedProjectionCaptureRequest, matchesCapturedProjectionState } from './projectionChangeCapture';
import { validateProjectionChangeIdentityMetadata, validateProjectionChangeWriteMetadata } from './projectionChangeMetadata';
import { replayProjectionChangeTransition } from './projectionChangePatch';
import type { ProjectionJsonValue } from './sourceCommit';
import type {
  CommitProjectionSourceCommitRequest,
  ProjectionSourceCommitSnapshot,
  ProjectionSourceCommitSnapshotTarget
} from './sourceCommitStore';
import { projectionUuidToBase64Url22 } from './uuidCodec';

/** Ordered RFC 6902 operations over portable JSON, including object members and array elements. */
export type ProjectionChangePatchOperation =
  | { readonly op: 'add' | 'replace'; readonly path: string; readonly value: ProjectionJsonValue }
  | { readonly op: 'remove'; readonly path: string };

export interface ProjectionChangeTransition {
  readonly eventId: string;
  readonly eventIndex: number;
  readonly changeType: 'create' | 'update' | 'noop';
  readonly patch: readonly ProjectionChangePatchOperation[];
}

export interface ProjectionChangeTarget {
  readonly targetDocumentId: string;
  readonly transitions: readonly ProjectionChangeTransition[];
}

/** One typed append, not a callback or an arbitrary store operation. */
export interface ProjectionChangesAppend {
  readonly kind: 'projection_changes';
  readonly collection: string;
  readonly targets: readonly ProjectionChangeTarget[];
}

export interface ProjectionChangesSourceIdentity {
  readonly collection: string;
  readonly sourceId: string;
  readonly commitId: string;
  readonly commitSequence: number;
}

interface ProjectionChangesReceiptIdentity extends ProjectionChangesSourceIdentity {
  readonly version: 1;
  readonly projectionName: string;
  readonly projectionGeneration: string;
  readonly resumeToken: string;
  /** Store-generated identity for one none-strategy invocation, never a delivery dedupe key. */
  readonly applicationId?: string;
}

export interface ProjectionChangesEmptyReceipt extends ProjectionChangesReceiptIdentity {
  readonly kind: 'projection_changes_empty';
}

export interface ProjectionChangesRecord extends ProjectionChangesReceiptIdentity {
  readonly kind: 'projection_changes';
  readonly targets: readonly (ProjectionChangeTarget & {
    readonly previousRevision: number | null;
    readonly revision: number;
  })[];
}

export type ProjectionChangesReceipt = ProjectionChangesRecord | ProjectionChangesEmptyReceipt;
export type ProjectionChangesReceiptStatus = 'committed' | 'mismatch' | 'missing';

export const MISSING_PROJECTION_CHANGES_HISTORY = 'Missing projection_changes history for a previously committed source turn.';

type ChangeScope = Pick<CommitProjectionSourceCommitRequest, 'projectionName' | 'projectionGeneration'>;

export function projectionChangesResumeToken(
  request: ChangeScope & (Pick<CommitProjectionSourceCommitRequest, 'commit'> | Pick<ProjectionChangesSourceIdentity, 'sourceId' | 'commitSequence'>),
  applicationId?: string
): string {
  const { sourceId, commitSequence } = 'commit' in request
    ? { sourceId: request.commit.streamId, commitSequence: request.commit.commitSequence } : request;
  const key = [request.projectionName, request.projectionGeneration, sourceId, commitSequence,
    ...(applicationId === undefined ? [] : [applicationId])];
  return `pc1.${Buffer.from(JSON.stringify(key)).toString('base64url')}`;
}

export function matchProjectionChangesReceipt(
  expected: ProjectionChangesSourceIdentity & ChangeScope,
  record: ProjectionChangesReceipt,
  applicationId?: string
): 'committed' | 'mismatch' {
  const validKind = record.kind === 'projection_changes_empty'
    || (record.kind === 'projection_changes' && Array.isArray(record.targets) && record.targets.length > 0);
  return validKind && record.version === 1 && record.resumeToken === projectionChangesResumeToken(expected, applicationId)
    && record.applicationId === applicationId
    && record.commitId === expected.commitId && record.collection === expected.collection
    && record.sourceId === expected.sourceId && record.commitSequence === expected.commitSequence
    && record.projectionName === expected.projectionName && record.projectionGeneration === expected.projectionGeneration
    ? 'committed' : 'mismatch';
}

export function projectionChangesIdentity(request: CommitProjectionSourceCommitRequest): (ProjectionChangesSourceIdentity & ChangeScope) | undefined {
  const append = request.additionalWrites?.[0];
  return append && {
    collection: append.collection,
    projectionName: request.projectionName, projectionGeneration: request.projectionGeneration,
    sourceId: request.commit.streamId, commitId: request.commit.commitId, commitSequence: request.commit.commitSequence
  };
}

export function buildProjectionChangesReceipt(request: CommitProjectionSourceCommitRequest, applicationId?: string): ProjectionChangesReceipt | undefined {
  const append = request.additionalWrites?.[0];
  const identity = projectionChangesIdentity(request);
  if (!append || !identity) return undefined;
  const base = { version: 1 as const, ...identity, resumeToken: projectionChangesResumeToken(request, applicationId),
    ...(applicationId === undefined ? {} : { applicationId }) };
  if (!append.targets.length) return { ...base, kind: 'projection_changes_empty' };
  const revisions = new Map(request.finalDocuments.map((document) => [document.targetDocumentId, document.expectedRevision]));
  return {
    ...base, kind: 'projection_changes',
    targets: append.targets.map((target) => {
      const previousRevision = revisions.get(target.targetDocumentId) ?? null;
      return { targetDocumentId: target.targetDocumentId, transitions: target.transitions,
        previousRevision, revision: (previousRevision ?? 0) + 1 };
    })
  };
}

export function validateProjectionChangesAppend(request: CommitProjectionSourceCommitRequest): string | null {
  if (request.additionalWrites === undefined) return null;
  const writes = request.additionalWrites;
  if (!Array.isArray(writes) || writes.length !== 1) return 'unsupported projection additional writes';
  const append = writes[0];
  if (append?.kind !== 'projection_changes'
    || typeof append.collection !== 'string' || !append.collection.trim() || !Array.isArray(append.targets)) {
    return 'unsupported projection additional writes';
  }
  const identityFailure = validateProjectionChangeIdentityMetadata({
    projectionName: request.projectionName, projectionGeneration: request.projectionGeneration,
    collection: append.collection, sourceId: request.commit.streamId,
    commitId: request.commit.commitId, commitSequence: request.commit.commitSequence
  });
  if (identityFailure) return identityFailure;
  if (request.progress.strategy === 'own_record' && (request.progress.source.sourceId !== request.commit.streamId
    || request.progress.source.finalSequence !== request.commit.commitSequence)) {
    return 'projection change own-record progress must refer to the source turn';
  }
  if (request.progress.strategy === 'in_document') {
    const sourceKey = projectionUuidToBase64Url22(request.commit.streamId);
    if (request.progress.targets.some((target) => target.final[sourceKey] !== request.commit.commitSequence)) {
      return 'projection change in-document progress must refer to the source turn';
    }
  }
  const documents = new Set(request.finalDocuments.map((document) => document.targetDocumentId));
  if (documents.size !== request.finalDocuments.length || append.targets.length !== documents.size) {
    return 'projection change targets must exactly match final documents';
  }
  for (const target of append.targets) {
    if (!target || !documents.delete(target.targetDocumentId) || !Array.isArray(target.transitions)
      || !target.transitions.length || !transitionsMatchEvents(target.transitions, request.commit.events)) {
      return 'invalid projection change target or event order';
    }
  }
  return validateProjectionChangeWriteMetadata(request, append);
}

/** Called when the store has already looked up the exact turn receipt and found none. */
export function projectionChangesHistoryFailure(
  request: CommitProjectionSourceCommitRequest,
  snapshot: ProjectionSourceCommitSnapshot
): string | null {
  if (!request.additionalWrites) return null;
  const sequence = request.commit.commitSequence;
  if (request.progress.strategy === 'own_record' && snapshot.ownRecordSequence !== null && snapshot.ownRecordSequence >= sequence) {
    return MISSING_PROJECTION_CHANGES_HISTORY;
  }
  if (request.progress.strategy === 'in_document' && snapshot.targets.length) {
    const sourceKey = projectionUuidToBase64Url22(request.commit.streamId);
    if (snapshot.targets.some((target) => (target.sourceProgress[sourceKey] ?? -1) >= sequence)) return MISSING_PROJECTION_CHANGES_HISTORY;
  }
  return null;
}

function transitionsMatchEvents(
  transitions: readonly ProjectionChangeTransition[],
  events: CommitProjectionSourceCommitRequest['commit']['events']
): boolean {
  let previous = -1;
  for (const transition of transitions) {
    if (!transition || !Number.isSafeInteger(transition.eventIndex) || transition.eventIndex <= previous
      || events[transition.eventIndex]?.eventId !== transition.eventId || typeof transition.eventId !== 'string'
      || events[transition.eventIndex]?.eventIndex !== transition.eventIndex
      || !Array.isArray(transition.patch)
      || Object.keys(transition).some((key) => !['eventId', 'eventIndex', 'changeType', 'patch'].includes(key))) return false;
    previous = transition.eventIndex;
  }
  return true;
}

function validateStateTransitions(
  original: ProjectionSourceCommitSnapshotTarget | undefined,
  result: unknown,
  transitions: readonly ProjectionChangeTransition[],
  exact: boolean
): string | null {
  if (!original) return 'projection change target is missing from the snapshot';
  const exists = original.revision !== null || original.legacyOriginal !== undefined || original.state !== null;
  let state: ProjectionJsonValue | undefined;
  if (exists) {
    if (!isPortableProjectionChangeJson(original.state)) return 'projection change snapshot must be portable JSON';
    state = original.state;
  }
  for (const transition of transitions) {
    const next = replayProjectionChangeTransition(state, transition);
    // Replay never mutates its input; unchanged values keep the preceding transition's proof.
    if (next === undefined || (!Object.is(next, state) && !isPortableProjectionChangeJson(next))) {
      return 'projection change patch cannot be applied as portable JSON to the snapshot';
    }
    state = next;
  }
  if (state !== undefined && Object.is(state, result)) return null;
  if (!isPortableProjectionChangeJson(result)) return 'projection change final document must be portable JSON';
  return state !== undefined && equalProjectionChangeJson(state, result, exact)
    ? null : 'projection change patch does not match the final document';
}

export type VerifiedProjectionSourceCommitStatePatch = {
  transitions: readonly ProjectionChangeTransition[];
  unchanged: boolean;
  /** Genuine Immer capture against the baseline, not a replay or portability certification. */
  captured?: true;
};

export function checkProjectionSourceCommitState<T>(
  request: CommitProjectionSourceCommitRequest<T>, snapshot: Pick<ProjectionSourceCommitSnapshot<T>, 'targets'>, allowCapture: boolean
): { failure: string | null; verified: ReadonlyMap<string, VerifiedProjectionSourceCommitStatePatch> } {
  if (allowCapture && !request.validateStateChanges && isSealedProjectionCaptureRequest(request)) {
    const originals = new Map(snapshot.targets.map((target) => [target.targetDocumentId, target]));
    const verified = new Map<string, VerifiedProjectionSourceCommitStatePatch>();
    for (const document of request.finalDocuments) {
      const original = originals.get(document.targetDocumentId);
      const hint = document.statePatch;
      if (!original || hint?.kind !== 'ordered' || !transitionsMatchEvents(hint.transitions, request.commit.events)) continue;
      const exists = original.revision !== null || original.legacyOriginal !== undefined || original.state !== null;
      if (matchesCapturedProjectionState(original.state, exists, document.finalDocument, hint.transitions)) {
        verified.set(document.targetDocumentId, { transitions: hint.transitions, captured: true,
          unchanged: exists && Object.is(original.state, document.finalDocument) });
      }
    }
    if (!request.additionalWrites?.[0].targets.some((target) => verified.get(target.targetDocumentId)?.transitions !== target.transitions)) {
      return { failure: null, verified };
    }
  }
  const verified = verifyProjectionSourceCommitStatePatches(request, snapshot);
  const failure = validateProjectionChangesState(request, snapshot, verified)
    ?? (request.validateStateChanges && verified.size !== request.finalDocuments.length ? 'Invalid projection state change hint.' : null);
  return { failure, verified };
}

/** Advisory data only: a missing or unproven hint must not change legacy full-document semantics. */
export function verifyProjectionSourceCommitStatePatches<TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  snapshot: Pick<ProjectionSourceCommitSnapshot<TState>, 'targets'>
): ReadonlyMap<string, VerifiedProjectionSourceCommitStatePatch> {
  const originals = new Map(snapshot.targets.map((target) => [target.targetDocumentId, target]));
  const verified = new Map<string, VerifiedProjectionSourceCommitStatePatch>();
  for (const document of request.finalDocuments) {
    const hint = document.statePatch;
    const original = originals.get(document.targetDocumentId);
    if (original && hint?.kind === 'ordered' && Array.isArray(hint.transitions) && hint.transitions.length
      && transitionsMatchEvents(hint.transitions, request.commit.events)
      && validateStateTransitions(original, document.finalDocument, hint.transitions, true) === null) {
      const unchanged = hint.transitions[0]!.changeType !== 'create' && (
        hint.transitions.every(({ changeType }) => changeType === 'noop') ||
        equalProjectionChangeJson(original.state as ProjectionJsonValue, document.finalDocument as ProjectionJsonValue, true)
      );
      verified.set(document.targetDocumentId, { transitions: hint.transitions, unchanged });
    }
  }
  return verified;
}

export function validateProjectionChangesState<TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  snapshot: Pick<ProjectionSourceCommitSnapshot<TState>, 'targets'>,
  verified?: ReadonlyMap<string, VerifiedProjectionSourceCommitStatePatch>
): string | null {
  const append = request.additionalWrites?.[0];
  if (!append) return null;
  const originals = new Map(snapshot.targets.map((target) => [target.targetDocumentId, target]));
  const results = new Map(request.finalDocuments.map((target) => [target.targetDocumentId, target.finalDocument]));
  for (const target of append.targets) {
    if (verified?.get(target.targetDocumentId)?.transitions === target.transitions) continue;
    const failure = validateStateTransitions(originals.get(target.targetDocumentId), results.get(target.targetDocumentId), target.transitions, false);
    if (failure) return failure;
  }
  return null;
}
