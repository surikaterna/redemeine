import type { ProjectionQueueRegistryManifest, ProjectionSha256Digest, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';

export type ProjectionMigrationStrategy = 'in_document' | 'own_record' | 'none';
export type ProjectionMigrationPhase = 'preflighted' | 'sources_verified' | 'sources_replayed' | 'activated' | 'verified' | 'rolled_back';

export interface ProjectionMigrationSourceRange {
  readonly sourceId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly commitCount: number;
  readonly expectedDigest: ProjectionSha256Digest;
}

export interface ProjectionMigrationManifest {
  readonly version: 2;
  readonly manifestDigest: ProjectionSha256Digest;
  readonly migrationId: string;
  readonly projectionName: string;
  readonly oldGeneration: string;
  readonly newGeneration: string;
  readonly destinationStrategies: Readonly<Record<string, ProjectionMigrationStrategy>>;
  readonly streamIdentity: 'immutable_uuid_no_reset';
  readonly oldRegistry: ProjectionQueueRegistryManifest;
  readonly newRegistry: ProjectionQueueRegistryManifest;
  readonly sourceRanges: readonly ProjectionMigrationSourceRange[];
  readonly authoritativeSourceDigest: ProjectionSha256Digest;
}

export interface ProjectionMigrationRangeJournal {
  readonly migrationId: string;
  readonly manifestDigest: ProjectionSha256Digest;
  readonly rangeKey: string;
  readonly expectedDigest: ProjectionSha256Digest;
  readonly observedDigest: ProjectionSha256Digest;
  readonly commitCount: number;
  readonly encodedBytes: number;
  readonly verifiedAt: string;
}

export interface ProjectionMigrationSnapshot {
  readonly documents: { count: number; digest: ProjectionSha256Digest };
  readonly links: { count: number; digest: ProjectionSha256Digest };
  readonly progress: { count: number; digest: ProjectionSha256Digest };
}

export interface ProjectionMigrationState {
  readonly migrationId: string;
  readonly manifestDigest: ProjectionSha256Digest;
  readonly revision: number;
  readonly phase: ProjectionMigrationPhase;
  readonly replaySnapshot?: ProjectionMigrationSnapshot;
  readonly activatedAt?: string;
  readonly verifiedAt?: string;
}

export interface ProjectionMigrationStatePort {
  load(migrationId: string): Promise<ProjectionMigrationState | null>;
  compareAndSet(expectedRevision: number | null, state: ProjectionMigrationState): Promise<boolean>;
  readJournal(migrationId: string): Promise<readonly ProjectionMigrationRangeJournal[]>;
  writeJournal(row: ProjectionMigrationRangeJournal): Promise<'written' | 'matches' | 'conflict'>;
}

export interface ProjectionMigrationTrustedPreflightPort {
  inspect(manifest: ProjectionMigrationManifest): Promise<readonly string[]>;
}

export interface ProjectionMigrationReplayPort {
  process(commit: ProjectionSourceCommit, context: {
    migrationId: string; manifestDigest: ProjectionSha256Digest; sourceId: string; expectedSequence: number | null; finalSequence: number;
  }): Promise<{ status: 'completed' | 'retryable' | 'terminal'; reason?: string }>;
}

export interface ProjectionMigrationSnapshotPort {
  read(): Promise<ProjectionMigrationSnapshot>;
}

export interface ProjectionMigrationActivationPort {
  activate(manifest: ProjectionMigrationManifest, expectedState: ProjectionMigrationState): Promise<ProjectionMigrationState | null>;
  verifyActive(manifest: ProjectionMigrationManifest): Promise<boolean>;
}

export interface ProjectionMigrationReceipt {
  readonly version: 2;
  readonly command: 'preflight' | 'verify-sources' | 'replay' | 'activate' | 'verify' | 'rollback';
  readonly migrationId: string;
  readonly manifestDigest: ProjectionSha256Digest;
  readonly status: 'ok' | 'rejected';
  readonly phase: ProjectionMigrationPhase | null;
  readonly revision: number | null;
  readonly mutated: boolean;
  readonly reasons: readonly string[];
  readonly snapshot?: ProjectionMigrationSnapshot;
}
