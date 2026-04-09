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
  readonly warnings?: readonly ProjectionRouteWarning[];
}

export interface ProjectionRouteWarning {
  readonly code: 'missing_reverse_target' | 'missing_target_removal';
  readonly projectionName: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventName: string;
  readonly targetId?: string;
}

export interface ProjectionWorkerMessage {
  readonly envelope: ProjectionRouterEnvelope;
  readonly routeDecision: ProjectionRouteDecision;
}

export interface ProjectionWorkerAck {
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface ProjectionWorkerTransportMetadata {
  readonly priority?: number;
  readonly retryCount?: number;
}

export interface ProjectionWorkerPushContract {
  push(
    definition: ProjectionDefinitionLike,
    message: ProjectionWorkerMessage,
    metadata?: ProjectionWorkerTransportMetadata
  ): Promise<ProjectionWorkerAck>;
}
