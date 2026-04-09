export type {
  ProjectionDefinitionLike,
  ProjectionRouteDecision,
  ProjectionRouteTarget,
  ProjectionRouterContract,
  ProjectionRouterEnvelope
} from './contracts';

import type {
  ProjectionDefinitionLike,
  ProjectionRouteDecision,
  ProjectionRouteTarget,
  ProjectionRouterContract,
  ProjectionRouterEnvelope
} from './contracts';

function asUniqueTargetIds(identity: string | readonly string[]): readonly string[] {
  const values = Array.isArray(identity) ? identity : [identity];
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    targets.push(value);
  }

  return targets;
}

function toRouteTarget(projectionName: string, targetId: string): ProjectionRouteTarget {
  return {
    targetId,
    laneKey: `${projectionName}:${targetId}`
  };
}

export function createProjectionRouter(): ProjectionRouterContract {
  return {
    route(
      definition: ProjectionDefinitionLike,
      envelope: ProjectionRouterEnvelope
    ): ProjectionRouteDecision {
      if (envelope.sourceStream !== definition.fromAggregateType) {
        return {
          projectionName: definition.projectionName,
          targets: []
        };
      }

      const targetIds = asUniqueTargetIds(definition.identity(envelope));
      const targets = targetIds.map((targetId) => toRouteTarget(definition.projectionName, targetId));

      return {
        projectionName: definition.projectionName,
        targets
      };
    }
  };
}
