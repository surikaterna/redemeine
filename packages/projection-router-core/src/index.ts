export type {
  ProjectionDefinitionLike,
  ProjectionLinkMutation,
  ProjectionRouteDecision,
  ProjectionRouteTarget,
  ProjectionRouteWarning,
  ProjectionRouterCreateOptions,
  ProjectionRouterContract,
  ProjectionRouterEnvelope,
  ProjectionRouterLinkStore,
  ProjectionReverseRuleLike
} from './contracts';

import type {
  ProjectionDefinitionLike,
  ProjectionLinkMutation,
  ProjectionRouteDecision,
  ProjectionRouteTarget,
  ProjectionRouteWarning,
  ProjectionRouterCreateOptions,
  ProjectionRouterContract,
  ProjectionRouterEnvelope,
  ProjectionRouterLinkStore,
  ProjectionReverseRuleLike
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

function normalizeTargetIdentity(
  identity: string | readonly string[] | null | undefined
): readonly string[] {
  if (!identity) {
    return [];
  }

  return asUniqueTargetIds(identity);
}

function createDefaultLinkStore(): ProjectionRouterLinkStore {
  const links = new Map<string, Set<string>>();

  function key(aggregateType: string, aggregateId: string): string {
    return `${aggregateType}:${aggregateId}`;
  }

  return {
    resolveTargets(aggregateType, aggregateId) {
      return Array.from(links.get(key(aggregateType, aggregateId)) ?? []);
    },
    addLink(aggregateType, aggregateId, targetId) {
      const mapKey = key(aggregateType, aggregateId);
      const existing = links.get(mapKey) ?? new Set<string>();
      existing.add(targetId);
      links.set(mapKey, existing);
    },
    removeLink(aggregateType, aggregateId, targetId) {
      const mapKey = key(aggregateType, aggregateId);
      const existing = links.get(mapKey);

      if (!existing) {
        return false;
      }

      const deleted = existing.delete(targetId);

      if (existing.size === 0) {
        links.delete(mapKey);
      }

      return deleted;
    }
  };
}

function toMissingRemovalWarning(
  projectionName: string,
  envelope: ProjectionRouterEnvelope,
  mutation: ProjectionLinkMutation
): ProjectionRouteWarning {
  return {
    code: 'missing_target_removal',
    projectionName,
    aggregateType: mutation.aggregateType,
    aggregateId: mutation.aggregateId,
    eventName: envelope.eventName,
    targetId: mutation.targetId
  };
}

function toMissingReverseTargetWarning(
  projectionName: string,
  envelope: ProjectionRouterEnvelope
): ProjectionRouteWarning {
  return {
    code: 'missing_reverse_target',
    projectionName,
    aggregateType: envelope.sourceStream,
    aggregateId: envelope.sourceId,
    eventName: envelope.eventName
  };
}

function isReverseAggregateEvent(
  envelope: ProjectionRouterEnvelope,
  reverseRules: readonly ProjectionReverseRuleLike[]
): boolean {
  return reverseRules.some((rule) => rule.aggregateType === envelope.sourceStream);
}

export function createProjectionRouter(options: ProjectionRouterCreateOptions = {}): ProjectionRouterContract {
  const linkStore = options.links ?? createDefaultLinkStore();
  const hasTarget = options.hasTarget;

  return {
    async route(
      definition: ProjectionDefinitionLike,
      envelope: ProjectionRouterEnvelope
    ): Promise<ProjectionRouteDecision> {
      const reverseRules = definition.reverseRules ?? [];

      const isFromEvent = envelope.sourceStream === definition.fromAggregateType;
      const isReverseEvent = isReverseAggregateEvent(envelope, reverseRules);

      if (!isFromEvent && !isReverseEvent) {
        return {
          projectionName: definition.projectionName,
          targets: [],
          warnings: []
        };
      }

      const warnings: ProjectionRouteWarning[] = [];

      if (definition.reverseLinkMutations) {
        for (const mutation of definition.reverseLinkMutations(envelope)) {
          if (mutation.op === 'add') {
            await linkStore.addLink(mutation.aggregateType, mutation.aggregateId, mutation.targetId);
            continue;
          }

          const removed = await linkStore.removeLink(
            mutation.aggregateType,
            mutation.aggregateId,
            mutation.targetId
          );

          if (!removed) {
            warnings.push(toMissingRemovalWarning(definition.projectionName, envelope, mutation));
          }
        }
      }

      const fanoutTargetIds = new Set<string>();

      if (isFromEvent) {
        for (const targetId of asUniqueTargetIds(definition.identity(envelope))) {
          fanoutTargetIds.add(targetId);
        }
      }

      if (isReverseEvent) {
        for (const targetId of await linkStore.resolveTargets(envelope.sourceStream, envelope.sourceId)) {
          fanoutTargetIds.add(targetId);
        }

        for (const rule of reverseRules) {
          if (rule.aggregateType !== envelope.sourceStream) {
            continue;
          }

          for (const targetId of normalizeTargetIdentity(rule.targetIdentity(envelope))) {
            fanoutTargetIds.add(targetId);
          }
        }

        if (fanoutTargetIds.size === 0) {
          warnings.push(toMissingReverseTargetWarning(definition.projectionName, envelope));
        }
      }

      const targetIds = Array.from(fanoutTargetIds);

      const resolvedTargetIds: string[] = [];
      for (const targetId of targetIds) {
        if (!hasTarget || (await hasTarget(targetId))) {
          resolvedTargetIds.push(targetId);
          continue;
        }

        warnings.push({
          code: 'missing_reverse_target',
          projectionName: definition.projectionName,
          aggregateType: envelope.sourceStream,
          aggregateId: envelope.sourceId,
          eventName: envelope.eventName,
          targetId
        });
      }

      const targets = resolvedTargetIds.map((targetId) =>
        toRouteTarget(definition.projectionName, targetId)
      );

      return {
        projectionName: definition.projectionName,
        targets,
        warnings
      };
    }
  };
}
