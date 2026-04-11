import type { MongoPatchPlanTelemetryEvent } from './types';

export interface MongoPatchPlanModeSummary {
  count: number;
  rate: number;
}

export interface MongoPatchLengthStats {
  min: number;
  max: number;
  avg: number;
}

export interface MongoPatchPlanTelemetryReport {
  totalEvents: number;
  modes: Record<string, MongoPatchPlanModeSummary>;
  fallbackReasons: Record<string, number>;
  cache: {
    hits: number;
    misses: number;
    hitRate: number;
    uniqueKeyCount: number;
  };
  patchLength: MongoPatchLengthStats;
}

const toRate = (count: number, total: number): number => {
  if (total <= 0) {
    return 0;
  }

  return count / total;
};

export const createPatchPlanTelemetryReport = (
  events: ReadonlyArray<MongoPatchPlanTelemetryEvent>
): MongoPatchPlanTelemetryReport => {
  if (events.length === 0) {
    return {
      totalEvents: 0,
      modes: {},
      fallbackReasons: {},
      cache: {
        hits: 0,
        misses: 0,
        hitRate: 0,
        uniqueKeyCount: 0
      },
      patchLength: {
        min: 0,
        max: 0,
        avg: 0
      }
    };
  }

  const modesRaw = new Map<string, number>();
  const fallbackReasons = new Map<string, number>();
  const uniqueKeys = new Set<string>();
  let hits = 0;
  let misses = 0;
  let minPatchLength = Number.POSITIVE_INFINITY;
  let maxPatchLength = 0;
  let totalPatchLength = 0;

  for (const event of events) {
    modesRaw.set(event.mode, (modesRaw.get(event.mode) ?? 0) + 1);

    if (event.fallbackReason) {
      fallbackReasons.set(event.fallbackReason, (fallbackReasons.get(event.fallbackReason) ?? 0) + 1);
    }

    uniqueKeys.add(event.cacheKey);

    if (event.cacheHit) {
      hits += 1;
    } else {
      misses += 1;
    }

    totalPatchLength += event.patchLength;
    minPatchLength = Math.min(minPatchLength, event.patchLength);
    maxPatchLength = Math.max(maxPatchLength, event.patchLength);
  }

  const totalEvents = events.length;
  const modes = Object.fromEntries(
    Array.from(modesRaw.entries()).map(([mode, count]) => [
      mode,
      {
        count,
        rate: toRate(count, totalEvents)
      }
    ])
  );

  return {
    totalEvents,
    modes,
    fallbackReasons: Object.fromEntries(fallbackReasons.entries()),
    cache: {
      hits,
      misses,
      hitRate: toRate(hits, totalEvents),
      uniqueKeyCount: uniqueKeys.size
    },
    patchLength: {
      min: Number.isFinite(minPatchLength) ? minPatchLength : 0,
      max: maxPatchLength,
      avg: totalPatchLength / totalEvents
    }
  };
};
