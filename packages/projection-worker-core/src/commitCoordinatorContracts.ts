import type {
  ProjectionCommitDefinition,
  ProjectionCompleteCommitRangeReader,
  ProjectionQueueRegistryManifest,
  ProjectionSourceCommit,
  ProjectionSourceCommitStorePort,
  ProjectionSourceOrderPort
} from '@redemeine/projection-runtime-core';
import type { ProjectionStateValidation } from './projectionCommitReducer';

export interface ProjectionCommitRegistryDefinition<TState = unknown> {
  readonly generation: string;
  readonly definition: ProjectionCommitDefinition<TState>;
  /** Enables history for this generation and names its logical target collection. */
  readonly projectionChanges?: string;
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
  /** Opt-in diagnostics, independent of whether the generation records history. */
  readonly stateValidation?: ProjectionStateValidation;
}

export interface ProjectionCommitCoordinator {
  process(commit: ProjectionSourceCommit): Promise<ProjectionCommitCoordinatorOutcome>;
  processPolled(commit: ProjectionSourceCommit): Promise<ProjectionCommitCoordinatorOutcome>;
}
