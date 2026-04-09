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

export interface ProjectionWorkerProcessingContext {
  readonly commit: ProjectionWorkerCommit;
  readonly metadata: ProjectionWorkerProcessingMetadata;
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

export interface ProjectionWorkerPushContract {
  push(commit: ProjectionWorkerCommit): Promise<ProjectionWorkerPushResult>;
  pushMany(commits: readonly ProjectionWorkerCommit[]): Promise<ProjectionWorkerPushManyResult>;
}
