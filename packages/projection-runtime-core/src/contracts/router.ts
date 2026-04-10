import type { ProjectionIngressEnvelope } from './envelope';

export interface ProjectionRoutingKey {
  projectionName: string;
  targetDocId: string;
}

export interface ProjectionRouterFanoutEnvelope {
  routingKey: ProjectionRoutingKey;
  routingKeySource: `${string}:${string}`;
  envelope: ProjectionIngressEnvelope;
}

export interface ProjectionRouterDecision {
  fanout: ProjectionRouterFanoutEnvelope[];
}
