import { describe, expect, it } from '@jest/globals';
import {
  evaluateSchedulerPolicy,
  SCHEDULER_UNLIMITED_REMAINING_RATE_LIMIT,
  type SchedulerDecisionCandidate
} from '../src/schedulerPolicyEvaluator';

const candidate = (
  id: string,
  tenantId: string,
  priority: number,
  runAt: string,
  sagaId = `${tenantId}-${id}`
): SchedulerDecisionCandidate => ({
  id,
  tenantId,
  priority,
  runAt,
  sagaId
});

describe('scheduler policy evaluator', () => {
  it('produces deterministic tenant-fair ordering while honoring per-tenant priority', () => {
    const result = evaluateSchedulerPolicy({
      maxDecisions: 4,
      candidates: [
        candidate('a-1', 'tenant-a', 100, '2026-01-01T00:00:01.000Z'),
        candidate('a-2', 'tenant-a', 1, '2026-01-01T00:00:02.000Z'),
        candidate('b-1', 'tenant-b', 50, '2026-01-01T00:00:01.000Z'),
        candidate('b-2', 'tenant-b', 49, '2026-01-01T00:00:02.000Z')
      ],
      tenantPolicies: {
        'tenant-a': { fairnessWeight: 1 },
        'tenant-b': { fairnessWeight: 1 }
      }
    });

    expect(result.selected.map((entry) => entry.candidate.id)).toEqual(['a-1', 'b-1', 'b-2', 'a-2']);
    expect(result.selected.map((entry) => entry.order)).toEqual([1, 2, 3, 4]);
    expect(result.deferred).toHaveLength(0);
    expect(result.tenantSummary).toEqual({
      'tenant-a': {
        selected: 2,
        deferredRateLimited: 0,
        remainingRateLimit: SCHEDULER_UNLIMITED_REMAINING_RATE_LIMIT
      },
      'tenant-b': {
        selected: 2,
        deferredRateLimited: 0,
        remainingRateLimit: SCHEDULER_UNLIMITED_REMAINING_RATE_LIMIT
      }
    });
  });

  it('treats explicit rateLimit.limit=0 as hard zero capacity and defers deterministically', () => {
    const result = evaluateSchedulerPolicy({
      maxDecisions: 2,
      candidates: [
        candidate('z-1', 'tenant-z', 100, '2026-01-01T00:00:01.000Z'),
        candidate('a-1', 'tenant-a', 10, '2026-01-01T00:00:01.000Z')
      ],
      tenantPolicies: {
        'tenant-z': {
          fairnessWeight: 1,
          rateLimit: { limit: 0 }
        },
        'tenant-a': {
          fairnessWeight: 1,
          rateLimit: { limit: 1 }
        }
      }
    });

    expect(result.selected.map((entry) => entry.candidate.id)).toEqual(['a-1']);
    expect(result.deferred).toEqual([
      {
        candidate: expect.objectContaining({ id: 'z-1', tenantId: 'tenant-z' }),
        reason: 'tenant_rate_limited'
      }
    ]);
    expect(result.tenantSummary).toEqual({
      'tenant-a': {
        selected: 1,
        deferredRateLimited: 0,
        remainingRateLimit: 0
      },
      'tenant-z': {
        selected: 0,
        deferredRateLimited: 1,
        remainingRateLimit: 0
      }
    });
  });

  it('marks remaining candidates as tenant_rate_limited when quota is exhausted', () => {
    const result = evaluateSchedulerPolicy({
      maxDecisions: 5,
      candidates: [
        candidate('a-1', 'tenant-a', 10, '2026-01-01T00:00:01.000Z'),
        candidate('a-2', 'tenant-a', 9, '2026-01-01T00:00:02.000Z'),
        candidate('b-1', 'tenant-b', 5, '2026-01-01T00:00:01.000Z')
      ],
      tenantPolicies: {
        'tenant-a': {
          fairnessWeight: 1,
          rateLimit: { limit: 1 }
        },
        'tenant-b': {
          fairnessWeight: 1,
          rateLimit: { limit: 5 }
        }
      }
    });

    expect(result.selected.map((entry) => entry.candidate.id)).toEqual(['a-1', 'b-1']);
    expect(result.deferred).toEqual([
      {
        candidate: expect.objectContaining({ id: 'a-2', tenantId: 'tenant-a' }),
        reason: 'tenant_rate_limited'
      }
    ]);
    expect(result.tenantSummary['tenant-a']).toEqual({
      selected: 1,
      deferredRateLimited: 1,
      remainingRateLimit: 0
    });
  });

  it('marks unscheduled candidates as global_capacity_exhausted when maxDecisions is reached', () => {
    const result = evaluateSchedulerPolicy({
      maxDecisions: 2,
      candidates: [
        candidate('a-1', 'tenant-a', 10, '2026-01-01T00:00:01.000Z'),
        candidate('b-1', 'tenant-b', 9, '2026-01-01T00:00:01.000Z'),
        candidate('c-1', 'tenant-c', 8, '2026-01-01T00:00:01.000Z')
      ]
    });

    expect(result.selected.map((entry) => entry.candidate.id)).toEqual(['a-1', 'b-1']);
    expect(result.deferred).toEqual([
      {
        candidate: expect.objectContaining({ id: 'c-1', tenantId: 'tenant-c' }),
        reason: 'global_capacity_exhausted'
      }
    ]);
  });
});
