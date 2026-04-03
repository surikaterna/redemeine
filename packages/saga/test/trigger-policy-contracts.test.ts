import { describe, expect, it } from '@jest/globals';
import type {
  SagaSchedulerTriggerPolicyContract,
  SagaTriggerMisfirePolicy,
  SagaTriggerStartContract
} from '../src/triggerContracts';

describe('scheduler trigger policy contracts', () => {
  it('supports misfire policy modes as stable discriminated unions', () => {
    const catchUpAll: SagaTriggerMisfirePolicy = { mode: 'catch_up_all' };
    const catchUpBounded: SagaTriggerMisfirePolicy = {
      mode: 'catch_up_bounded',
      maxCatchUpCount: 25
    };
    const latestOnly: SagaTriggerMisfirePolicy = { mode: 'latest_only' };
    const skipUntilNext: SagaTriggerMisfirePolicy = { mode: 'skip_until_next' };

    expect(catchUpAll.mode).toBe('catch_up_all');
    expect(catchUpBounded.mode).toBe('catch_up_bounded');
    expect(catchUpBounded.maxCatchUpCount).toBe(25);
    expect(latestOnly.mode).toBe('latest_only');
    expect(skipUntilNext.mode).toBe('skip_until_next');
  });

  it('allows optional restart and misfire policy contracts on trigger start contracts', () => {
    const schedulerPolicy: SagaSchedulerTriggerPolicyContract = {
      restart: {
        mode: 'graceful',
        reason: 'restart from trigger overlap'
      },
      misfire: {
        mode: 'catch_up_bounded',
        maxCatchUpCount: 10
      }
    };

    const triggerContract: SagaTriggerStartContract = {
      schedulerPolicy
    };

    expect(triggerContract.schedulerPolicy?.restart?.mode).toBe('graceful');
    expect(triggerContract.schedulerPolicy?.misfire?.mode).toBe('catch_up_bounded');
  });

  it('rejects invalid policy shapes at compile time', () => {
    // @ts-expect-error misfire mode must be one of the supported contract variants
    const invalidMisfire: SagaTriggerMisfirePolicy = { mode: 'ignore' };

    // @ts-expect-error catch_up_bounded requires maxCatchUpCount
    const missingBound: SagaTriggerMisfirePolicy = { mode: 'catch_up_bounded' };

    const contract: SagaTriggerStartContract = {
      schedulerPolicy: {
        // @ts-expect-error restart mode only accepts graceful|force
        restart: { mode: 'soft' },
        misfire: { mode: 'latest_only' }
      }
    };

    void invalidMisfire;
    void missingBound;
    void contract;
    expect(true).toBe(true);
  });
});
