import type {
  ProjectionCommitDefinition,
  ProjectionCompleteCommitRangeReader,
  ProjectionQueueRegistryManifest,
  ProjectionSourceCommit,
  ProjectionSourceCommitStorePort,
  ProjectionMigrationCommitReceipt,
  ProjectionSourceOrderPort
} from '@redemeine/projection-runtime-core';

export interface ProjectionCommitRegistryDefinition<TState = unknown> {
  readonly generation: string;
  readonly definition: ProjectionCommitDefinition<TState>;
}

export type ProjectionDefinitionCommitOutcome =
  | { status: 'committed' | 'deduplicated'; attempts: number }
  | { status: 'conflict' | 'transient' | 'ambiguous'; retryable: true; reason: string; attempts: number }
  | { status: 'terminal'; retryable: false; reason: string; attempts: number };

export interface ProjectionDefinitionCommitResult {
  readonly projectionName: string;
  readonly projectionGeneration: string;
  readonly outcome: ProjectionDefinitionCommitOutcome;
}

export type ProjectionCommitCoordinatorOutcome =
  | { status: 'completed'; processedSequences: readonly number[]; definitions: readonly ProjectionDefinitionCommitResult[] }
  | {
      status: 'retryable' | 'terminal';
      reason: string;
      processedSequences: readonly number[];
      definitions: readonly ProjectionDefinitionCommitResult[];
    };

export interface ProjectionCommitCoordinatorOptions<TState = unknown> {
  readonly queueBindingId: string;
  readonly manifest: ProjectionQueueRegistryManifest;
  readonly definitions: readonly ProjectionCommitRegistryDefinition<TState>[];
  readonly store: ProjectionSourceCommitStorePort<TState>;
  readonly sourceOrder: ProjectionSourceOrderPort;
  readonly rangeReader: ProjectionCompleteCommitRangeReader;
  readonly maxCommits: number;
  readonly maxBytes: number;
  readonly maxGapPages?: number;
  readonly maxConflictRetries?: number;
  /** Only the isolated migration CLI may set this; serving coordinators reject receipt bypass. */
  readonly migrationReplay?: true;
}

export interface ProjectionCommitCoordinator {
  process(commit: ProjectionSourceCommit, migrationReceipt?: ProjectionMigrationCommitReceipt): Promise<ProjectionCommitCoordinatorOutcome>;
  processPolled(commit: ProjectionSourceCommit): Promise<ProjectionCommitCoordinatorOutcome>;
}
