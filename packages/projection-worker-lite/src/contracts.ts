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

export interface ProjectionWorkerLiteContract {
  push(message: ProjectionWorkerLiteMessage): Promise<void>;
}
