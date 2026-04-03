import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateSchedulerPolicy,
  type SchedulerDecisionCandidate,
  type SchedulerPolicyEvaluatorInput,
  type SchedulerTenantPolicy
} from '../src/schedulerPolicyEvaluator';

interface TenantProfile {
  readonly id: string;
  readonly share: number;
  readonly fairnessWeight: number;
  readonly perMinuteRateLimit: number;
  readonly basePriority: number;
}

interface TenantScaleStats {
  arrived: number;
  selected: number;
  deferredRateLimited: number;
  deferredGlobalCapacity: number;
  maxConsecutiveBlockedMinutes: number;
}

interface ScaleValidationOptions {
  readonly seed?: number;
  readonly minutes?: number;
  readonly baseArrivalsPerMinute?: number;
  readonly maxDecisionsPerMinute?: number;
}

export interface ScaleValidationSummary {
  readonly scenario: {
    readonly seed: number;
    readonly minutes: number;
    readonly maxDecisionsPerMinute: number;
    readonly baseArrivalsPerMinute: number;
    readonly targetSagasPerDay: number;
  };
  readonly totals: {
    readonly arrived: number;
    readonly selected: number;
    readonly deferredRateLimited: number;
    readonly deferredGlobalCapacity: number;
    readonly finalBacklog: number;
    readonly projectedSagasPerDay: number;
  };
  readonly throughput: {
    readonly minPerMinute: number;
    readonly maxPerMinute: number;
    readonly averagePerMinute: number;
    readonly p50PerMinute: number;
    readonly p95PerMinute: number;
    readonly minutesAtOrAboveTargetRate: number;
  };
  readonly fairness: {
    readonly tenantsWithArrivalsButNoSelection: readonly string[];
    readonly worstBlockedTenant: {
      readonly tenantId: string;
      readonly maxConsecutiveBlockedMinutes: number;
    };
  };
  readonly methodology: {
    readonly model: string;
    readonly workload: string;
    readonly policyCoverage: readonly string[];
  };
  readonly tenantStats: Readonly<Record<string, TenantScaleStats>>;
}

const TARGET_SAGAS_PER_DAY = 200_000;
const TARGET_PER_MINUTE = TARGET_SAGAS_PER_DAY / 1_440;
const DEFAULT_SEED = 13;
const DEFAULT_MINUTES = 1_440;
const DEFAULT_BASE_ARRIVALS_PER_MINUTE = 160;
const DEFAULT_MAX_DECISIONS_PER_MINUTE = 165;

const TENANTS: readonly TenantProfile[] = [
  { id: 'tenant-enterprise-a', share: 0.30, fairnessWeight: 7, perMinuteRateLimit: 58, basePriority: 95 },
  { id: 'tenant-enterprise-b', share: 0.22, fairnessWeight: 5, perMinuteRateLimit: 45, basePriority: 90 },
  { id: 'tenant-growth-a', share: 0.15, fairnessWeight: 3, perMinuteRateLimit: 30, basePriority: 75 },
  { id: 'tenant-growth-b', share: 0.11, fairnessWeight: 2, perMinuteRateLimit: 23, basePriority: 70 },
  { id: 'tenant-smb-a', share: 0.08, fairnessWeight: 1, perMinuteRateLimit: 13, basePriority: 55 },
  { id: 'tenant-smb-b', share: 0.07, fairnessWeight: 1, perMinuteRateLimit: 11, basePriority: 52 },
  { id: 'tenant-longtail-a', share: 0.04, fairnessWeight: 1, perMinuteRateLimit: 6, basePriority: 40 },
  { id: 'tenant-longtail-b', share: 0.03, fairnessWeight: 1, perMinuteRateLimit: 5, basePriority: 38 }
];

const createSeededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = ((state * 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

const percentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * (sorted.length - 1))));
  return sorted[index] ?? 0;
};

const burstAdjustment = (tenantId: string, minute: number): number => {
  if (tenantId === 'tenant-enterprise-a' && minute % 180 < 24) {
    return 8;
  }

  if (tenantId === 'tenant-enterprise-b' && minute % 240 >= 45 && minute % 240 < 75) {
    return 6;
  }

  if (tenantId.startsWith('tenant-longtail') && minute % 90 < 10) {
    return 2;
  }

  return 0;
};

const globalSpikeMultiplier = (minute: number): number => {
  const cycleMinute = minute % 360;
  if (cycleMinute < 12) {
    return 1.2;
  }

  return 1;
};

export function runSchedulerScaleValidation(
  options: ScaleValidationOptions = {}
): ScaleValidationSummary {
  const seed = options.seed ?? DEFAULT_SEED;
  const minutes = options.minutes ?? DEFAULT_MINUTES;
  const baseArrivalsPerMinute = options.baseArrivalsPerMinute ?? DEFAULT_BASE_ARRIVALS_PER_MINUTE;
  const maxDecisionsPerMinute = options.maxDecisionsPerMinute ?? DEFAULT_MAX_DECISIONS_PER_MINUTE;

  const random = createSeededRandom(seed);
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');

  const tenantPolicies: Record<string, SchedulerTenantPolicy> = Object.fromEntries(
    TENANTS.map((tenant) => [tenant.id, {
      fairnessWeight: tenant.fairnessWeight,
      rateLimit: { limit: tenant.perMinuteRateLimit }
    }])
  );

  const tenantStats: Record<string, TenantScaleStats> = Object.fromEntries(
    TENANTS.map((tenant) => [tenant.id, {
      arrived: 0,
      selected: 0,
      deferredRateLimited: 0,
      deferredGlobalCapacity: 0,
      maxConsecutiveBlockedMinutes: 0
    }])
  );

  const blockedMinutes: Record<string, number> = Object.fromEntries(TENANTS.map((tenant) => [tenant.id, 0]));
  const perMinuteSelected: number[] = [];

  let pending: SchedulerDecisionCandidate[] = [];
  let totalArrived = 0;
  let totalSelected = 0;
  let totalDeferredRateLimited = 0;
  let totalDeferredGlobalCapacity = 0;
  let globalSequence = 0;

  for (let minute = 0; minute < minutes; minute += 1) {
    const minuteStartMs = startMs + (minute * 60_000);
    const arrivalsThisMinute: SchedulerDecisionCandidate[] = [];
    const arrivalsByTenant: Record<string, number> = Object.fromEntries(TENANTS.map((tenant) => [tenant.id, 0]));

    const spikeMultiplier = globalSpikeMultiplier(minute);

    for (const tenant of TENANTS) {
      const expected = baseArrivalsPerMinute * tenant.share * spikeMultiplier;
      const jitter = Math.floor(random() * 7) - 3;
      const burst = burstAdjustment(tenant.id, minute);
      const arrivals = Math.max(0, Math.round(expected + jitter + burst));

      arrivalsByTenant[tenant.id] = arrivals;
      tenantStats[tenant.id].arrived += arrivals;
      totalArrived += arrivals;

      for (let index = 0; index < arrivals; index += 1) {
        globalSequence += 1;
        const runAtMs = minuteStartMs + (index * 30);
        arrivalsThisMinute.push({
          id: `cand-${minute}-${globalSequence}`,
          sagaId: `saga-${tenant.id}-${globalSequence}`,
          tenantId: tenant.id,
          runAt: new Date(runAtMs).toISOString(),
          priority: tenant.basePriority - Math.floor(random() * 6)
        });
      }
    }

    const backlogBefore = pending.reduce<Record<string, number>>((acc, candidate) => {
      acc[candidate.tenantId] = (acc[candidate.tenantId] ?? 0) + 1;
      return acc;
    }, {});

    const input: SchedulerPolicyEvaluatorInput = {
      maxDecisions: maxDecisionsPerMinute,
      candidates: [...pending, ...arrivalsThisMinute],
      tenantPolicies
    };

    const result = evaluateSchedulerPolicy(input);
    const selectedByTenant: Record<string, number> = Object.fromEntries(TENANTS.map((tenant) => [tenant.id, 0]));

    for (const selection of result.selected) {
      selectedByTenant[selection.candidate.tenantId] += 1;
      tenantStats[selection.candidate.tenantId].selected += 1;
      totalSelected += 1;
    }

    for (const deferred of result.deferred) {
      if (deferred.reason === 'tenant_rate_limited') {
        tenantStats[deferred.candidate.tenantId].deferredRateLimited += 1;
        totalDeferredRateLimited += 1;
      } else {
        tenantStats[deferred.candidate.tenantId].deferredGlobalCapacity += 1;
        totalDeferredGlobalCapacity += 1;
      }
    }

    for (const tenant of TENANTS) {
      const tenantId = tenant.id;
      const hadDemand = (backlogBefore[tenantId] ?? 0) + (arrivalsByTenant[tenantId] ?? 0) > 0;
      const gotSelection = (selectedByTenant[tenantId] ?? 0) > 0;

      if (hadDemand && !gotSelection) {
        blockedMinutes[tenantId] += 1;
      } else {
        blockedMinutes[tenantId] = 0;
      }

      tenantStats[tenantId].maxConsecutiveBlockedMinutes = Math.max(
        tenantStats[tenantId].maxConsecutiveBlockedMinutes,
        blockedMinutes[tenantId]
      );
    }

    perMinuteSelected.push(result.selected.length);
    pending = result.deferred.map((entry) => entry.candidate);
  }

  const selectedMin = perMinuteSelected.length > 0 ? Math.min(...perMinuteSelected) : 0;
  const selectedMax = perMinuteSelected.length > 0 ? Math.max(...perMinuteSelected) : 0;
  const selectedAverage = perMinuteSelected.length > 0
    ? Number((perMinuteSelected.reduce((sum, value) => sum + value, 0) / perMinuteSelected.length).toFixed(2))
    : 0;

  const tenantsWithArrivalsButNoSelection = TENANTS
    .filter((tenant) => tenantStats[tenant.id].arrived > 0 && tenantStats[tenant.id].selected === 0)
    .map((tenant) => tenant.id);

  const worstBlockedTenant = TENANTS
    .map((tenant) => ({
      tenantId: tenant.id,
      maxConsecutiveBlockedMinutes: tenantStats[tenant.id].maxConsecutiveBlockedMinutes
    }))
    .sort((left, right) => right.maxConsecutiveBlockedMinutes - left.maxConsecutiveBlockedMinutes)[0];

  return {
    scenario: {
      seed,
      minutes,
      maxDecisionsPerMinute,
      baseArrivalsPerMinute,
      targetSagasPerDay: TARGET_SAGAS_PER_DAY
    },
    totals: {
      arrived: totalArrived,
      selected: totalSelected,
      deferredRateLimited: totalDeferredRateLimited,
      deferredGlobalCapacity: totalDeferredGlobalCapacity,
      finalBacklog: pending.length,
      projectedSagasPerDay: Math.round(selectedAverage * 1_440)
    },
    throughput: {
      minPerMinute: selectedMin,
      maxPerMinute: selectedMax,
      averagePerMinute: selectedAverage,
      p50PerMinute: percentile(perMinuteSelected, 0.5),
      p95PerMinute: percentile(perMinuteSelected, 0.95),
      minutesAtOrAboveTargetRate: perMinuteSelected.filter((value) => value >= TARGET_PER_MINUTE).length
    },
    fairness: {
      tenantsWithArrivalsButNoSelection,
      worstBlockedTenant
    },
    methodology: {
      model: 'Deterministic minute-level simulation with carry-over backlog and seeded pseudo-random arrivals',
      workload: '8-tenant mixed profile, weighted shares, periodic bursts, and recurring global spikes',
      policyCoverage: ['fairness_weight', 'tenant_rate_limit', 'global_capacity_limit', 'anti_starvation_rotation']
    },
    tenantStats
  };
}

const formatNumber = (value: number): string => value.toLocaleString('en-US');

export function toScaleValidationMarkdown(summary: ScaleValidationSummary): string {
  const throughputCoverage = `${summary.throughput.minutesAtOrAboveTargetRate}/${summary.scenario.minutes}`;
  const tenantRows = Object.entries(summary.tenantStats)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tenantId, stats]) =>
      `| ${tenantId} | ${formatNumber(stats.arrived)} | ${formatNumber(stats.selected)} | ${formatNumber(stats.deferredRateLimited)} | ${formatNumber(stats.deferredGlobalCapacity)} | ${stats.maxConsecutiveBlockedMinutes} |`
    )
    .join('\n');

  return [
    '# redemeine-b13 Scale Validation Report',
    '',
    '## Scenario',
    `- Seed: ${summary.scenario.seed}`,
    `- Horizon: ${summary.scenario.minutes} minutes (24h representative simulation)`,
    `- Base arrivals/minute: ${summary.scenario.baseArrivalsPerMinute}`,
    `- Scheduler max decisions/minute: ${summary.scenario.maxDecisionsPerMinute}`,
    `- Target: ${formatNumber(summary.scenario.targetSagasPerDay)} sagas/day`,
    '',
    '## Throughput envelope',
    `- Arrived: ${formatNumber(summary.totals.arrived)}`,
    `- Selected (processed): ${formatNumber(summary.totals.selected)}`,
    `- Projected sagas/day from average throughput: ${formatNumber(summary.totals.projectedSagasPerDay)}`,
    `- Final backlog after horizon: ${formatNumber(summary.totals.finalBacklog)}`,
    `- Throughput min/avg/p95/max per minute: ${summary.throughput.minPerMinute}/${summary.throughput.averagePerMinute}/${summary.throughput.p95PerMinute}/${summary.throughput.maxPerMinute}`,
    `- Minutes at or above target rate (${TARGET_PER_MINUTE.toFixed(2)} per minute): ${throughputCoverage}`,
    '',
    '## Methodology',
    `- Model: ${summary.methodology.model}`,
    `- Workload: ${summary.methodology.workload}`,
    `- Policy coverage: ${summary.methodology.policyCoverage.join(', ')}`,
    '',
    '## Policy behavior under load',
    `- Deferred due to tenant rate limits: ${formatNumber(summary.totals.deferredRateLimited)}`,
    `- Deferred due to global capacity: ${formatNumber(summary.totals.deferredGlobalCapacity)}`,
    `- Tenants with arrivals but zero selections: ${summary.fairness.tenantsWithArrivalsButNoSelection.length === 0 ? 'none' : summary.fairness.tenantsWithArrivalsButNoSelection.join(', ')}`,
    `- Worst blocked streak: ${summary.fairness.worstBlockedTenant.tenantId} (${summary.fairness.worstBlockedTenant.maxConsecutiveBlockedMinutes} consecutive minutes with demand but no selection)`,
    '',
    '## Per-tenant stats',
    '| Tenant | Arrived | Selected | Deferred (rate-limited) | Deferred (global cap) | Max blocked streak (minutes) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    tenantRows,
    ''
  ].join('\n');
}

const parseArgValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.findIndex((entry) => entry === flag);
  if (index < 0) {
    return undefined;
  }

  return args[index + 1];
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const summary = runSchedulerScaleValidation();

  console.log(JSON.stringify(summary, null, 2));

  const markdownPath = parseArgValue(args, '--markdown');
  if (markdownPath) {
    const markdown = toScaleValidationMarkdown(summary);
    writeFileSync(resolve(markdownPath), markdown, 'utf8');
    console.log(`Wrote scale validation markdown to ${resolve(markdownPath)}`);
  }
}
