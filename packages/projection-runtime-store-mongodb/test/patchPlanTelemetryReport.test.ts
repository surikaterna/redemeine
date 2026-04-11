import { describe, expect, test } from 'bun:test';
import type { MongoPatchPlanTelemetryEvent } from '../src';
import { createPatchPlanTelemetryReport } from '../src';

describe('createPatchPlanTelemetryReport', () => {
  test('returns zeroed report for empty events', () => {
    const report = createPatchPlanTelemetryReport([]);

    expect(report).toEqual({
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
    });
  });

  test('aggregates mode rates fallback reasons and cache stats', () => {
    const events: MongoPatchPlanTelemetryEvent[] = [
      {
        documentId: 'doc-1',
        mode: 'compiled-update-document',
        cacheKey: 'k1',
        cacheHit: false,
        patchLength: 1
      },
      {
        documentId: 'doc-2',
        mode: 'fallback-full-document',
        fallbackReason: 'remove-not-compileable',
        cacheKey: 'k2',
        cacheHit: false,
        patchLength: 3
      },
      {
        documentId: 'doc-3',
        mode: 'compiled-update-pipeline',
        cacheKey: 'k1',
        cacheHit: true,
        patchLength: 2
      },
      {
        documentId: 'doc-4',
        mode: 'fallback-full-document',
        fallbackReason: 'remove-not-compileable',
        cacheKey: 'k3',
        cacheHit: true,
        patchLength: 4
      }
    ];

    const report = createPatchPlanTelemetryReport(events);

    expect(report.totalEvents).toBe(4);
    expect(report.modes['compiled-update-document']).toEqual({ count: 1, rate: 0.25 });
    expect(report.modes['compiled-update-pipeline']).toEqual({ count: 1, rate: 0.25 });
    expect(report.modes['fallback-full-document']).toEqual({ count: 2, rate: 0.5 });
    expect(report.fallbackReasons).toEqual({ 'remove-not-compileable': 2 });
    expect(report.cache).toEqual({
      hits: 2,
      misses: 2,
      hitRate: 0.5,
      uniqueKeyCount: 3
    });
    expect(report.patchLength).toEqual({ min: 1, max: 4, avg: 2.5 });
  });
});
