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

export interface ProjectionWorkerLiteMessage {
  readonly definition: ProjectionDefinitionLike;
  readonly envelope: ProjectionRouterEnvelope;
}

export type ProjectionWorkerLiteGuarantee = 'best_effort';

export const PROJECTION_WORKER_LITE_GUARANTEE: ProjectionWorkerLiteGuarantee = 'best_effort';

export interface ProjectionWorkerLiteProcessedDecision {
  readonly status: 'processed';
}

export interface ProjectionWorkerLiteDroppedDecision {
  readonly status: 'dropped';
  readonly reason: string;
}

export type ProjectionWorkerLiteDecision =
  | ProjectionWorkerLiteProcessedDecision
  | ProjectionWorkerLiteDroppedDecision;

export interface ProjectionWorkerLitePushResult {
  readonly guarantee: ProjectionWorkerLiteGuarantee;
  readonly decision: ProjectionWorkerLiteDecision;
}

export interface ProjectionWorkerLitePushManyResult {
  readonly guarantee: ProjectionWorkerLiteGuarantee;
  readonly items: readonly ProjectionWorkerLitePushResult[];
}

export interface ProjectionWorkerLiteContract {
  push(message: ProjectionWorkerLiteMessage): Promise<ProjectionWorkerLitePushResult>;
  pushMany(messages: readonly ProjectionWorkerLiteMessage[]): Promise<ProjectionWorkerLitePushManyResult>;
}

export type ProjectionWorkerLiteProcessor = (
  message: ProjectionWorkerLiteMessage
) => Promise<ProjectionWorkerLiteDecision> | ProjectionWorkerLiteDecision;
