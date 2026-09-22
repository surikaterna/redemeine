import type { ProjectionQueueRegistryManifest, ProjectionSha256Digest } from '@redemeine/projection-runtime-core';

export type ProjectionMigrationStrategy = 'in_document' | 'own_record' | 'none';
export type ProjectionMigrationMode = 'rebuild' | 'in_place';
export type ProjectionMigrationPhase = 'preflighted' | 'quiesced' | 'activated' | 'verified' | 'rolled_back';

export interface ProjectionMigrationSourceEvidence {
  readonly sourceId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly commitCount: number;
  readonly completeCommitBoundaries: true;
  readonly rangeDigest: ProjectionSha256Digest;
}

export interface ProjectionMigrationSnapshotEvidence {
  readonly boundaryDigest: ProjectionSha256Digest;
  readonly stateDigest: ProjectionSha256Digest;
  readonly linkDigest: ProjectionSha256Digest;
}

export interface ProjectionMigrationManifest {
  readonly version: 1;
  readonly manifestDigest: ProjectionSha256Digest;
  readonly migrationId: string;
  readonly mode: ProjectionMigrationMode;
  readonly oldRegistry: ProjectionQueueRegistryManifest;
  readonly newRegistry: ProjectionQueueRegistryManifest;
  readonly projectionName: string;
  readonly oldGeneration: string;
  readonly newGeneration: string;
  readonly oldStrategy: ProjectionMigrationStrategy;
  readonly newStrategy: ProjectionMigrationStrategy;
  readonly streamIdentity: 'immutable_uuid_no_reset';
  readonly transportStartAnchors: Readonly<Record<string, number>>;
  readonly sourceCommitRanges: readonly ProjectionMigrationSourceEvidence[];
  readonly authoritativeBoundaryDigest: ProjectionSha256Digest;
  readonly authoritativeSourceDigest: ProjectionSha256Digest;
  readonly snapshot: ProjectionMigrationSnapshotEvidence | null;
  readonly executableCodeDigest: ProjectionSha256Digest;
  readonly runtimeConfigDigest: ProjectionSha256Digest;
  readonly retainOldArtifacts: boolean;
}

export interface ProjectionMigrationQuiesceEvidence {
  readonly oldQueueDepth: 0;
  readonly oldActiveWriters: 0;
  readonly newActiveWriters: 0;
  readonly drainedAt: string;
  readonly digest: ProjectionSha256Digest;
}

export interface ProjectionMigrationVerification {
  readonly replayedRangesDigest: ProjectionSha256Digest;
  readonly stateDigest: ProjectionSha256Digest;
  readonly linkDigest: ProjectionSha256Digest;
  readonly activeWriters: 1;
  readonly verifiedAt: string;
}

export interface ProjectionMigrationReplayEvidence {
  readonly replayedRangesDigest: ProjectionSha256Digest;
  readonly stateDigest: ProjectionSha256Digest;
  readonly linkDigest: ProjectionSha256Digest;
  readonly completedAt: string;
}

export interface ProjectionMigrationState {
  readonly migrationId: string;
  readonly manifestDigest: ProjectionSha256Digest;
  readonly revision: number;
  readonly phase: ProjectionMigrationPhase;
  readonly quiesceEvidence?: ProjectionMigrationQuiesceEvidence;
  readonly replayEvidence?: ProjectionMigrationReplayEvidence;
  readonly verification?: ProjectionMigrationVerification;
  readonly activatedAt?: string;
  readonly rollbackReason?: string;
}

export interface ProjectionMigrationStatePort {
  load(migrationId: string): Promise<ProjectionMigrationState | null>;
  compareAndSet(expectedRevision: number | null, state: ProjectionMigrationState): Promise<boolean>;
}

export interface ProjectionMigrationRegistryPort {
  adopt(manifest: ProjectionQueueRegistryManifest): Promise<'bound' | 'matches' | 'conflict'>;
}

export interface ProjectionMigrationReceipt {
  readonly version: 1;
  readonly command: 'preflight' | 'quiesce' | 'activate' | 'verify' | 'rollback';
  readonly migrationId: string;
  readonly manifestDigest: ProjectionSha256Digest;
  readonly status: 'ok' | 'rejected';
  readonly phase: ProjectionMigrationPhase | null;
  readonly revision: number | null;
  readonly mutated: boolean;
  readonly reasons: readonly string[];
}
