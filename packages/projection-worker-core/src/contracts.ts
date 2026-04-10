import type {
  Checkpoint,
  ProjectionCatchupPollingAdapter,
  ProjectionEvent
} from '@redemeine/projection-runtime-core';

export interface ProjectionDefinitionLike {
  readonly projectionName: string;
}

export interface ProjectionRouterEnvelope {
  readonly projectionName: string;
  readonly sourceStream: string;
  readonly sourceId: string;
  readonly eventName: string;
  readonly payload: unknown;
}

export interface ProjectionRouteTarget {
  readonly targetId: string;
  readonly laneKey: string;
}

export interface ProjectionRouteDecision {
  readonly projectionName: string;
  readonly targets: readonly ProjectionRouteTarget[];
}

export interface ProjectionWorkerMessage {
  readonly envelope: ProjectionRouterEnvelope;
  readonly routeDecision: ProjectionRouteDecision;
}

export interface ProjectionWorkerTransportMetadata {
  readonly priority?: number;
  readonly retryCount?: number;
}

export interface ProjectionWorkerCommit {
  readonly definition: ProjectionDefinitionLike;
  readonly message: ProjectionWorkerMessage;
  readonly metadata?: ProjectionWorkerTransportMetadata;
}

export interface ProjectionWorkerProcessingMetadata {
  readonly priority: number;
  readonly retryCount: number;
}

export interface ProjectionWorkerStateRequest {
  readonly definition: ProjectionDefinitionLike;
  readonly projectionName: string;
  readonly targetId: string;
}

export type ProjectionWorkerStateLoader = (
  request: ProjectionWorkerStateRequest
) => Promise<unknown | null> | unknown | null;

export interface ProjectionWorkerProjectionStateAccess {
  getProjectionState(targetId: string): Promise<unknown | null>;
  setProjectionState(targetId: string, state: unknown | null): void;
  evictProjectionState(targetId: string): void;
}

export interface ProjectionWorkerProcessingContext extends ProjectionWorkerProjectionStateAccess {
  readonly commit: ProjectionWorkerCommit;
  readonly metadata: ProjectionWorkerProcessingMetadata;
  readonly laneKeys: readonly string[];
}

export interface ProjectionWorkerBatchProcessingContext extends ProjectionWorkerProjectionStateAccess {
  readonly commits: readonly ProjectionWorkerCommit[];
  readonly metadata: readonly ProjectionWorkerProcessingMetadata[];
  readonly laneKeys: readonly string[];
}

export interface ProjectionWorkerAckDecision {
  readonly status: 'ack';
}

export interface ProjectionWorkerNackDecision {
  readonly status: 'nack';
  readonly retryable: boolean;
  readonly reason: string;
}

export type ProjectionWorkerDecision = ProjectionWorkerAckDecision | ProjectionWorkerNackDecision;

export interface ProjectionWorkerResultItem {
  readonly definition: ProjectionDefinitionLike;
  readonly message: ProjectionWorkerMessage;
  readonly metadata: ProjectionWorkerProcessingMetadata;
  readonly decision: ProjectionWorkerDecision;
}

export interface ProjectionWorkerPushResult {
  readonly item: ProjectionWorkerResultItem;
}

export interface ProjectionWorkerPushManyResult {
  readonly items: readonly ProjectionWorkerResultItem[];
}

export type ProjectionWorkerProcessor = (
  context: ProjectionWorkerProcessingContext
) => Promise<ProjectionWorkerDecision> | ProjectionWorkerDecision;

export type ProjectionWorkerBatchProcessor = (
  context: ProjectionWorkerBatchProcessingContext
) => Promise<readonly ProjectionWorkerDecision[]> | readonly ProjectionWorkerDecision[];

export type ProjectionWorkerMicroBatchingMode = 'none' | 'single' | 'all';

export interface ProjectionWorkerProjectionConfig {
  readonly microBatching?: ProjectionWorkerMicroBatchingMode;
}

export type ProjectionWorkerProjectionConfigResolver = (
  definition: ProjectionDefinitionLike
) => ProjectionWorkerProjectionConfig | undefined;

export interface ProjectionWorkerStateCacheOptions {
  readonly maxEntries: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export type ProjectionWorkerStoreFailureKind = 'conflict' | 'transient' | 'terminal';

export interface ProjectionWorkerStoreFailure {
  readonly kind: ProjectionWorkerStoreFailureKind;
  readonly reason?: string;
}

export interface ProjectionWorkerCoreOptions {
  readonly processor: ProjectionWorkerProcessor;
  readonly batchProcessor?: ProjectionWorkerBatchProcessor;
  readonly getProjectionConfig?: ProjectionWorkerProjectionConfigResolver;
  readonly stateLoader?: ProjectionWorkerStateLoader;
  readonly stateCache?: ProjectionWorkerStateCacheOptions;
}

export interface ProjectionWorkerPushContract {
  push(commit: ProjectionWorkerCommit): Promise<ProjectionWorkerPushResult>;
  pushMany(commits: readonly ProjectionWorkerCommit[]): Promise<ProjectionWorkerPushManyResult>;
}

export interface ProjectionWorkerReplayPollingAdapterOptions {
  readonly polling: ProjectionCatchupPollingAdapter;
  readonly worker: ProjectionWorkerPushContract;
  readonly toCommit: (event: ProjectionEvent) => ProjectionWorkerCommit;
  readonly initialCursor?: Checkpoint;
  readonly dedupeKey?: (event: ProjectionEvent) => string;
}

export interface ProjectionWorkerReplayPollingNack {
  readonly event: ProjectionEvent;
  readonly decision: ProjectionWorkerNackDecision;
}

export interface ProjectionWorkerReplayPollingResult {
  readonly cursorStart: Checkpoint;
  readonly cursorEnd: Checkpoint;
  readonly polledCount: number;
  readonly pushedCount: number;
  readonly dedupedCount: number;
  readonly nack?: ProjectionWorkerReplayPollingNack;
}

export interface ProjectionWorkerReplayPollingAdapter {
  getCursor(): Checkpoint;
  pollAndPush(batchSize: number): Promise<ProjectionWorkerReplayPollingResult>;
}
