export interface ProjectionDefinitionLike {
  readonly projectionName: string;
  readonly fromAggregateType: string;
  readonly identity: (envelope: ProjectionRouterEnvelope) => string | readonly string[];
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

export interface ProjectionRouterContract {
  route(
    definition: ProjectionDefinitionLike,
    envelope: ProjectionRouterEnvelope
  ): ProjectionRouteDecision;
}
