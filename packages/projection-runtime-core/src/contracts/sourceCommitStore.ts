import type { ProjectionSourceCommit } from './sourceCommit';
import { assertJoinIdentifier, type ProjectionJoinMembership, type ProjectionJoinMembershipFence, validateJoinMembershipFences } from './joinMembership';
import type { ProjectionUuidBase64Url22 } from './uuidCodec';
import {
  type ProjectionChangesAppend,
  type ProjectionChangesEmptyReceipt,
  type ProjectionChangesRecord,
  type ProjectionChangesReceiptStatus,
  type ProjectionChangesSourceIdentity,
  type ProjectionChangeTransition,
  validateProjectionChangesAppend
} from './projectionChanges';

/** Advisory ordered state patches; older adapters can persist the authoritative final document. */
export type ProjectionSourceCommitStatePatch =
  | { readonly kind: 'ordered'; readonly transitions: readonly ProjectionChangeTransition[] }
  | { readonly kind: 'full'; readonly reason: 'nonportable-state' | 'unrepresentable-patch' };

export interface ProjectionSourceCommitDocument<TState = unknown> {
  targetDocumentId: string;
  expectedRevision: number | null;
  finalDocument: TState;
  statePatch?: ProjectionSourceCommitStatePatch;
  /** Original legacy fields observed before the first v2 write; absence is significant. */
  legacyOriginal?: ProjectionLegacyDocumentOriginal<TState>;
}

export interface ProjectionLegacyDocumentOriginal<TState> {
  state: TState;
  updatedAt?: string;
  checkpoint?: unknown;
}

export interface ProjectionSourceCommitLink {
  operation: 'subscribe' | 'unsubscribe';
  targetDocumentId: string;
  aggregateType: string;
  aggregateId: string;
  /** Revision observed while routing. Null means that no membership existed. */
  expectedRevision: number | null;
}

export interface ProjectionInDocumentTargetProgress {
  targetDocumentId: string;
  expected: Readonly<Record<ProjectionUuidBase64Url22, number>>;
  final: Readonly<Record<ProjectionUuidBase64Url22, number>>;
}

export interface ProjectionInDocumentCommitProgress {
  strategy: 'in_document';
  targets: readonly ProjectionInDocumentTargetProgress[];
  warnings?: { warnAtSourceCount?: number; warnAtMetadataBytes?: number };
}

export interface ProjectionOwnRecordCommitProgress {
  strategy: 'own_record';
  source: {
    sourceId: string;
    expectedSequence: number | null;
    finalSequence: number;
    /** Accepted B, inserted with the first post-cutover progress row. */
    baselineSequence?: number;
  };
  warnings?: { warnAtSourceCount?: number; warnAtMetadataBytes?: number };
}

export interface ProjectionNoCommitProgress {
  strategy: 'none';
}

export type ProjectionSourceCommitProgress =
  | ProjectionInDocumentCommitProgress
  | ProjectionOwnRecordCommitProgress
  | ProjectionNoCommitProgress;

export interface CommitProjectionSourceCommitRequest<TState = unknown> {
  version: 1;
  mode: 'atomic-all';
  projectionName: string;
  projectionGeneration: string;
  commit: ProjectionSourceCommit;
  finalDocuments: readonly ProjectionSourceCommitDocument<TState>[];
  stagedLinks: readonly ProjectionSourceCommitLink[];
  /** Set-v1 replaces scalar links; includes unchanged and absent observations. */
  joinMembershipFences?: readonly ProjectionJoinMembershipFence[];
  joinSeedVersion?: 1;
  progress: ProjectionSourceCommitProgress;
  additionalWrites?: readonly [ProjectionChangesAppend];
  /** Enables strict state diagnostics even for an internally captured request. */
  validateStateChanges?: true;
}

export interface CommitProjectionSourceCommitCommitted {
  version: 1;
  status: 'committed';
  /** True when this result acknowledges a reliable turn committed by an earlier invocation. */
  replayed?: true;
  commitSequence: number;
  documentRevisions: Readonly<Record<string, number>>;
  linkRevisions: Readonly<Record<string, number>>;
  progress: ProjectionSourceCommitProgress;
  additionalWrites?: readonly [ProjectionChangesRecord];
  /** Durable proof for a recording turn that produced no target transitions. */
  emptyChangeReceipt?: ProjectionChangesEmptyReceipt;
}

export interface CommitProjectionSourceCommitRejected {
  version: 1;
  status: 'rejected';
  category: 'conflict' | 'transient' | 'terminal';
  retryable: boolean;
  reason: string;
}

export type CommitProjectionSourceCommitResult =
  | CommitProjectionSourceCommitCommitted
  | CommitProjectionSourceCommitRejected;

export interface ProjectionSourceCommitStorePort<TState = unknown> {
  /** Explicit opt-in; adapters must preserve receipt checks and atomic writes, including empty turns. */
  readonly projectionChangesCapability?: 'atomic-turn-receipts-v1' | undefined;
  /** Native loaders may defer fresh receipt checks to the commit CAS. */
  readonly sourceCommitSnapshotCapability?: 'revision-cas-v1' | undefined;
  /** Set snapshots must observe target presence and routing membership at one coherent read point. */
  readonly joinMembershipCapability?: 'set-v1' | undefined;
  readonly joinSeedCapability?: 'atomic-join-seed-v1' | undefined;
  loadProjectionSourceCommitSnapshot(
    request: LoadProjectionSourceCommitSnapshotRequest
  ): Promise<ProjectionSourceCommitSnapshot<TState>>;
  commitProjectionSourceCommit(
    request: CommitProjectionSourceCommitRequest<TState>,
    snapshot?: ProjectionSourceCommitSnapshot<TState>
  ): Promise<CommitProjectionSourceCommitResult>;
}

export function validateCommitProjectionSourceCommitRelationships<TState>(
  request: CommitProjectionSourceCommitRequest<TState>
): string | null {
  const allowed = ['version', 'mode', 'projectionName', 'projectionGeneration', 'commit', 'finalDocuments', 'stagedLinks', 'progress', 'additionalWrites', 'validateStateChanges', 'joinMembershipFences', 'joinSeedVersion'];
  if (Object.keys(request).some((key) => !allowed.includes(key))) return 'unsupported source commit request fields';
  if (request.validateStateChanges !== undefined && request.validateStateChanges !== true) return 'invalid state validation flag';
  if (request.joinSeedVersion !== undefined && (request.joinSeedVersion !== 1 || !request.joinMembershipFences
    || request.progress.strategy !== 'own_record')) return 'Join initialization requires own_record and membership fences.';
  if (request.joinMembershipFences !== undefined) {
    if (request.stagedLinks.length || request.progress.strategy === 'in_document') return 'Join membership sets cannot use scalar links or in_document.';
    try {
      assertJoinIdentifier(request.projectionName);
      assertJoinIdentifier(request.projectionGeneration);
      for (const document of request.finalDocuments) assertJoinIdentifier(document.targetDocumentId);
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid joined identifier.';
    }
    const invalid = validateJoinMembershipFences(request.joinMembershipFences);
    if (invalid) return invalid;
    if (!request.joinSeedVersion && request.joinMembershipFences.some((fence) => fence.seeds !== undefined)) {
      return 'Join seed provenance requires the initialized membership capability.';
    }
  }
  const malformedAppend = validateProjectionChangesAppend(request);
  if (malformedAppend) return malformedAppend;
  if (request.progress.strategy === 'own_record' && request.progress.source.baselineSequence !== undefined) {
    const source = request.progress.source;
    const baseline = source.baselineSequence;
    if (source.expectedSequence !== null || baseline === undefined || !Number.isSafeInteger(baseline)
      || baseline < -1 || baseline >= source.finalSequence) {
      return 'own-record accepted baseline must be seeded with the first post-cutover source turn';
    }
  }
  if (request.progress.strategy !== 'in_document') return null;
  const documentIds = request.finalDocuments.map((document) => document.targetDocumentId);
  const progressIds = request.progress.targets.map((target) => target.targetDocumentId);
  const documentSet = new Set(documentIds);
  const progressSet = new Set(progressIds);
  if (documentSet.size !== documentIds.length) return 'in-document request contains duplicate final document targets';
  if (progressSet.size !== progressIds.length) return 'in-document request contains duplicate progress targets';
  if (documentSet.size !== progressSet.size) return 'in-document progress targets must exactly match final document targets';
  for (const targetId of documentSet) {
    if (!progressSet.has(targetId)) return 'in-document progress targets must exactly match final document targets';
  }
  return null;
}

export interface ProjectionSourceCommitSnapshotTarget<TState = unknown> {
  targetDocumentId: string;
  revision: number | null;
  state: TState | null;
  sourceProgress: Readonly<Record<ProjectionUuidBase64Url22, number>>;
  legacyOriginal?: ProjectionLegacyDocumentOriginal<TState>;
}

export interface ProjectionSourceCommitSnapshotLink {
  aggregateType: string;
  aggregateId: string;
  targetDocumentId: string | null;
  revision: number | null;
}

export interface LoadProjectionSourceCommitSnapshotRequest {
  projectionName: string;
  projectionGeneration: string;
  targetDocumentIds: readonly string[];
  links: readonly { aggregateType: string; aggregateId: string }[];
  joinMembership?: 'set-v1';
  joinSeedVersion?: 1;
  progressStrategy: ProjectionSourceCommitProgress['strategy'];
  sourceId?: string;
  /** Canonical receipt lookup for reliable dedupe strategies, independent of scalar progress. */
  changeIdentity?: ProjectionChangesSourceIdentity;
  /** Only set when the store advertises revision-cas-v1. Exact replays still require receipt verification. */
  prepareSourceCommit?: boolean;
}

export interface ProjectionSourceCommitSnapshot<TState = unknown> {
  targets: readonly ProjectionSourceCommitSnapshotTarget<TState>[];
  links: readonly ProjectionSourceCommitSnapshotLink[];
  joinMemberships?: readonly ProjectionJoinMembership[];
  ownRecordSequence: number | null;
  changeReceipt?: ProjectionChangesReceiptStatus;
}
