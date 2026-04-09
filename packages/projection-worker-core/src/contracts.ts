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
