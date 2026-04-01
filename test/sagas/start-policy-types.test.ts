import { describe, expect, it } from '@jest/globals';
import { startPolicy, type SagaStartPolicy, type SagaTriggerStartContract } from '../../src/sagas';

describe('saga startPolicy typed helpers', () => {
  it('creates typed ifIdle/joinExisting/restart policies', () => {
    const idle = startPolicy.ifIdle();
    const join = startPolicy.joinExisting();
    const restart = startPolicy.restart({ mode: 'graceful', reason: 'manual re-run' });

    const accepted: SagaStartPolicy[] = [idle, join, restart];
    const triggerContract: SagaTriggerStartContract = {
      startPolicy: restart
    };

    expect(accepted.map(policy => policy.type)).toEqual(['if-idle', 'join-existing', 'restart']);
    expect(triggerContract.startPolicy?.type).toBe('restart');
    expect(restart.options?.mode).toBe('graceful');
  });

  it('rejects invalid policy literals at compile time', () => {
    // @ts-expect-error magic string is not assignable to SagaStartPolicy
    const invalidString: SagaStartPolicy = 'if-idle';

    // @ts-expect-error unknown start policy variant is rejected
    const invalidType: SagaStartPolicy = { type: 'unknown-policy' };

    // @ts-expect-error restart mode only accepts graceful|force
    startPolicy.restart({ mode: 'immediate' });

    void invalidString;
    void invalidType;

    expect(true).toBe(true);
  });
});
