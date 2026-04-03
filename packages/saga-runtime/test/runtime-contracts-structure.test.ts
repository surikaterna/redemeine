import { describe, expect, it } from '@jest/globals';
import type {
  SagaSchedulerTriggerPolicyContract,
  SagaTriggerMisfirePolicy,
  SagaTriggerStartContract
} from '../src';

describe('runtime contract structure', () => {
  it('exports scheduler trigger restart and misfire policy contracts', () => {
    const misfireModes: SagaTriggerMisfirePolicy[] = [
      { mode: 'catch_up_all' },
      { mode: 'catch_up_bounded', maxCatchUpCount: 3 },
      { mode: 'latest_only' },
      { mode: 'skip_until_next' }
    ];

    const schedulerPolicy: SagaSchedulerTriggerPolicyContract = {
      restart: { mode: 'force', reason: 'overlap' },
      misfire: misfireModes[1]
    };

    const trigger: SagaTriggerStartContract = {
      schedulerPolicy
    };

    expect(misfireModes.map((mode) => mode.mode)).toEqual([
      'catch_up_all',
      'catch_up_bounded',
      'latest_only',
      'skip_until_next'
    ]);
    expect(trigger.schedulerPolicy?.restart?.mode).toBe('force');
    expect(trigger.schedulerPolicy?.misfire?.mode).toBe('catch_up_bounded');
  });
});
