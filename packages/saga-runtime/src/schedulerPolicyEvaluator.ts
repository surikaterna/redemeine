export interface SchedulerDecisionCandidate {
  readonly id: string;
  readonly sagaId: string;
  readonly tenantId: string;
  readonly runAt: string;
  readonly priority: number;
}

export interface SchedulerTenantRateLimitSnapshot {
  readonly limit: number;
  readonly consumed?: number;
}

export interface SchedulerTenantPolicy {
  readonly fairnessWeight?: number;
  readonly rateLimit?: SchedulerTenantRateLimitSnapshot;
}

export interface SchedulerPolicyEvaluatorInput {
  readonly candidates: readonly SchedulerDecisionCandidate[];
  readonly maxDecisions: number;
  readonly tenantPolicies?: Readonly<Record<string, SchedulerTenantPolicy>>;
  readonly defaultTenantPolicy?: SchedulerTenantPolicy;
}

export type SchedulerDeferredReason = 'tenant_rate_limited' | 'global_capacity_exhausted';

export interface SchedulerDecisionSelection {
  readonly candidate: SchedulerDecisionCandidate;
  readonly order: number;
}

export interface SchedulerDecisionDeferred {
  readonly candidate: SchedulerDecisionCandidate;
  readonly reason: SchedulerDeferredReason;
}

export interface SchedulerTenantDecisionSummary {
  readonly selected: number;
  readonly deferredRateLimited: number;
  readonly remainingRateLimit: number;
}

export interface SchedulerPolicyEvaluationResult {
  readonly selected: readonly SchedulerDecisionSelection[];
  readonly deferred: readonly SchedulerDecisionDeferred[];
  readonly tenantSummary: Readonly<Record<string, SchedulerTenantDecisionSummary>>;
}

interface TenantRuntimeState {
  readonly tenantId: string;
  readonly fairnessWeight: number;
  readonly queue: SchedulerDecisionCandidate[];
  deficit: number;
  skippedRounds: number;
  remainingRateLimit: number;
  selected: number;
  deferredRateLimited: number;
}

const DEFAULT_FAIRNESS_WEIGHT = 1;
export const SCHEDULER_UNLIMITED_REMAINING_RATE_LIMIT = -1;

const normalizePositiveInteger = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
};

const normalizeNonNegativeInteger = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : fallback;
};

const normalizeOptionalNonNegativeInteger = (value: number | undefined): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
};

const compareCandidateRank = (left: SchedulerDecisionCandidate, right: SchedulerDecisionCandidate): number => {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  const runAtCompare = left.runAt.localeCompare(right.runAt);
  if (runAtCompare !== 0) {
    return runAtCompare;
  }

  const idCompare = left.id.localeCompare(right.id);
  if (idCompare !== 0) {
    return idCompare;
  }

  return left.sagaId.localeCompare(right.sagaId);
};

const compareTenantRuntimeState = (
  starvationThreshold: number
) => (left: TenantRuntimeState, right: TenantRuntimeState): number => {
  const leftStarved = left.skippedRounds >= starvationThreshold;
  const rightStarved = right.skippedRounds >= starvationThreshold;

  if (leftStarved !== rightStarved) {
    return leftStarved ? -1 : 1;
  }

  if (left.deficit !== right.deficit) {
    return right.deficit - left.deficit;
  }

  const leftTop = left.queue[0];
  const rightTop = right.queue[0];

  if (leftTop && rightTop) {
    const topCompare = compareCandidateRank(leftTop, rightTop);
    if (topCompare !== 0) {
      return topCompare;
    }
  }

  return left.tenantId.localeCompare(right.tenantId);
};

export function evaluateSchedulerPolicy(
  input: SchedulerPolicyEvaluatorInput
): SchedulerPolicyEvaluationResult {
  const maxDecisions = normalizeNonNegativeInteger(input.maxDecisions, 0);

  const tenantStateById = new Map<string, TenantRuntimeState>();

  for (const candidate of input.candidates) {
    const policy = input.tenantPolicies?.[candidate.tenantId];
    const fallbackPolicy = input.defaultTenantPolicy;

    const fairnessWeight = normalizePositiveInteger(
      policy?.fairnessWeight ?? fallbackPolicy?.fairnessWeight,
      DEFAULT_FAIRNESS_WEIGHT
    );

    const limit = normalizeOptionalNonNegativeInteger(
      policy?.rateLimit?.limit ?? fallbackPolicy?.rateLimit?.limit
    );

    const consumed = normalizeNonNegativeInteger(
      policy?.rateLimit?.consumed ?? fallbackPolicy?.rateLimit?.consumed,
      0
    );

    const runtimeState = tenantStateById.get(candidate.tenantId) ?? {
      tenantId: candidate.tenantId,
      fairnessWeight,
      queue: [],
      deficit: 0,
      skippedRounds: 0,
      remainingRateLimit: typeof limit === 'number' ? Math.max(0, limit - consumed) : Number.POSITIVE_INFINITY,
      selected: 0,
      deferredRateLimited: 0
    };

    runtimeState.queue.push(candidate);
    tenantStateById.set(candidate.tenantId, runtimeState);
  }

  for (const state of tenantStateById.values()) {
    state.queue.sort(compareCandidateRank);
  }

  const selected: SchedulerDecisionSelection[] = [];
  const deferred: SchedulerDecisionDeferred[] = [];

  while (selected.length < maxDecisions) {
    const eligible = Array.from(tenantStateById.values()).filter(
      (state) => state.queue.length > 0 && state.remainingRateLimit > 0
    );

    if (eligible.length === 0) {
      break;
    }

    for (const state of eligible) {
      state.skippedRounds += 1;
    }

    let totalWeight = 0;
    for (const state of eligible) {
      totalWeight += state.fairnessWeight;
      state.deficit += state.fairnessWeight;
    }

    const starvationThreshold = Math.max(2, eligible.length * 2);
    eligible.sort(compareTenantRuntimeState(starvationThreshold));
    const winner = eligible[0];
    const next = winner.queue.shift();
    if (!next) {
      continue;
    }

    winner.skippedRounds = 0;
    winner.remainingRateLimit -= 1;
    winner.selected += 1;
    winner.deficit -= totalWeight;

    selected.push({
      candidate: next,
      order: selected.length + 1
    });
  }

  for (const state of tenantStateById.values()) {
    const reason: SchedulerDeferredReason = state.remainingRateLimit <= 0
      ? 'tenant_rate_limited'
      : 'global_capacity_exhausted';

    for (const candidate of state.queue) {
      if (reason === 'tenant_rate_limited') {
        state.deferredRateLimited += 1;
      }

      deferred.push({
        candidate,
        reason
      });
    }
  }

  deferred.sort((left, right) => {
    const tenantCompare = left.candidate.tenantId.localeCompare(right.candidate.tenantId);
    if (tenantCompare !== 0) {
      return tenantCompare;
    }

    const candidateCompare = compareCandidateRank(left.candidate, right.candidate);
    if (candidateCompare !== 0) {
      return candidateCompare;
    }

    return left.reason.localeCompare(right.reason);
  });

  const tenantSummary = Object.fromEntries(
    Array.from(tenantStateById.values())
      .sort((left, right) => left.tenantId.localeCompare(right.tenantId))
      .map((state) => [state.tenantId, {
        selected: state.selected,
        deferredRateLimited: state.deferredRateLimited,
        remainingRateLimit: Number.isFinite(state.remainingRateLimit)
          ? state.remainingRateLimit
          : SCHEDULER_UNLIMITED_REMAINING_RATE_LIMIT
      }])
  );

  return {
    selected,
    deferred,
    tenantSummary
  };
}
