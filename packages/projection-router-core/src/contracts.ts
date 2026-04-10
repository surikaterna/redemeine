export interface ProjectionDefinitionLike {
  readonly projectionName: string;
  readonly fromAggregateType: string;
  readonly identity: (envelope: ProjectionRouterEnvelope) => string | readonly string[];
  readonly reverseRules?: readonly ProjectionReverseRuleLike[];
  readonly reverseLinkMutations?: (
    envelope: ProjectionRouterEnvelope
  ) => readonly ProjectionLinkMutation[];
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
  readonly warnings: readonly ProjectionRouteWarning[];
}

export interface ProjectionReverseRuleLike {
  readonly aggregateType: string;
  readonly targetIdentity: (
    envelope: ProjectionRouterEnvelope
  ) => string | readonly string[] | null | undefined;
}

export interface ProjectionLinkMutation {
  readonly op: 'add' | 'remove';
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly targetId: string;
}

export interface ProjectionRouteWarning {
  readonly code: 'missing_reverse_target' | 'missing_target_removal';
  readonly projectionName: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventName: string;
  readonly targetId?: string;
}

export interface ProjectionRouterLinkStore {
  resolveTargets(
    aggregateType: string,
    aggregateId: string
  ): readonly string[] | Promise<readonly string[]>;
  addLink(
    aggregateType: string,
    aggregateId: string,
    targetId: string
  ): void | Promise<void>;
  removeLink(
    aggregateType: string,
    aggregateId: string,
    targetId: string
  ): boolean | Promise<boolean>;
}

export interface ProjectionRouterCreateOptions {
  readonly links?: ProjectionRouterLinkStore;
  readonly hasTarget?: (targetId: string) => boolean | Promise<boolean>;
}

export interface ProjectionRouterContract {
  route(
    definition: ProjectionDefinitionLike,
    envelope: ProjectionRouterEnvelope
  ): Promise<ProjectionRouteDecision>;
}
