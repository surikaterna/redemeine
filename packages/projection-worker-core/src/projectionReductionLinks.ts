import {
  isJoinSeedBinding, joinMembershipKey, type JoinSeedKey, type ProjectionContext, type ProjectionJoinSource, type ProjectionSourceCommitLink
} from '@redemeine/projection-runtime-core';
import type { JoinMembershipStaging } from './joinMembershipReduction';
import type { JoinSeedEvent } from './joinSeedReduction';
import type { RoutingLinkState } from './projectionCommitRouting';

export interface ReductionLinks {
  links: Map<string, RoutingLinkState>;
  memberships?: JoinMembershipStaging;
  membershipReads: Set<string>;
  stagedLinks: Map<string, ProjectionSourceCommitLink>;
  missingLinks: Map<string, ProjectionJoinSource>;
}

function stageScalarLink(reduction: ReductionLinks, source: ProjectionJoinSource, target: string, subscribe: boolean): void {
  const { aggregateType, aggregateId } = source;
  const key = `${aggregateType}\u0000${aggregateId}`;
  const current = reduction.links.get(key);
  if (!current) reduction.missingLinks.set(key, source);
  else reduction.stagedLinks.set(key, {
    ...source, operation: subscribe ? 'subscribe' : 'unsubscribe', targetDocumentId: target, expectedRevision: current.revision
  });
  reduction.links.set(key, { ...source, targetDocumentId: subscribe ? target : null, revision: current?.revision ?? null });
}

export function createReductionContext<T>(
  reduction: ReductionLinks, target: string, attached?: Set<string>, seeds?: JoinSeedEvent<T>
): ProjectionContext {
  function stage(type: string, id: string, subscribe: boolean, binding?: JoinSeedKey) {
    // Validate the initializer first, but do not record it until membership staging also succeeds.
    const applySeed = seeds?.prepareStage(type, id, subscribe, binding);
    const source = { aggregateType: type, aggregateId: id };
    const key = reduction.memberships
      ? reduction.memberships.stage(reduction.missingLinks, source, target, subscribe)
      : joinMembershipKey(type, id);
    if (reduction.memberships) reduction.membershipReads.add(key);
    else stageScalarLink(reduction, source, target, subscribe);
    if (subscribe) attached?.add(key);
    else attached?.delete(key);
    applySeed?.();
  }

  return {
    ...(seeds?.coverage !== undefined ? { joinSeedCoverage: seeds.coverage } : {}),
    subscribeTo(input, id) {
      if (isJoinSeedBinding(input)) {
        if (!seeds) throw new Error('subscribeTo initialization requires a registered native join initializer.');
        stage(input.sourceAggregateType, id, true, input);
        return;
      }
      if (!('aggregateType' in input)) throw new Error('Invalid subscribeTo aggregate or join initializer.');
      stage(input.aggregateType, id, true);
    },
    unsubscribeFrom(aggregate, id) {
      stage(aggregate.aggregateType, id, false);
    }
  };
}
