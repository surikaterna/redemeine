import { describe, expect, it } from '@jest/globals';
import { PhaseEvidence, type CrashPhase } from '../integration/crashPhaseEvidence';
import { runCrashLifecycle, type LifecycleResult } from '../integration/crashRunLifecycle';

const preReady: CrashPhase[] = [
  'stack-construction', 'child-fork', 'source-append', 'source-publish', 'initial-delivery', 'child-ready'
];

describe('sanitized crash pre-ready phases', () => {
  it.each(preReady)('retains first %s failure over simultaneous cleanup error', async phase => {
    const phases = new PhaseEvidence();
    const first = new Error('amqp://user:private-password@localhost/fake payload');
    const cleanup = new Error('second error private-password');
    let receipt: { first: unknown; cleanup: unknown; result: LifecycleResult } | undefined;
    await expect(runCrashLifecycle(async () => phases.run(phase, () => { throw first; }),
      async () => { throw cleanup; }, async result => {
        receipt = { first: phases.firstFailure, cleanup: result.cleanupFailure, result };
      }, phases)).rejects.toThrow('owned crash scenario failed');
    expect(receipt?.first).toMatchObject({ phase, errorClass: 'operation', code: null, source: 'crash-parent' });
    expect(receipt?.cleanup).toMatchObject({ phase: 'cleanup', errorClass: 'operation', code: null });
    expect(receipt?.result.success).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('private-password');
    expect(phases.steps).toContainEqual({ phase, status: 'started' });
  });

  it('accepts only allowlisted network codes, numbers and fixed timeout class', async () => {
    const phases = new PhaseEvidence();
    const error = Object.assign(new Error('private-password'), { code: 'ECONNREFUSED', replyCode: 403 });
    await expect(phases.run('child-ready', () => { throw error; })).rejects.toBe(error);
    expect(phases.firstFailure).toMatchObject({ phase: 'child-ready', code: 403, errorClass: 'operation' });
    phases.fail(new Error('later')); // First cause is immutable.
    expect(phases.firstFailure?.phase).toBe('child-ready');
    const timeout = new PhaseEvidence();
    await expect(timeout.run('child-ready', () => new Promise<void>(() => undefined), 20)).rejects.toThrow('timed out');
    expect(timeout.firstFailure).toMatchObject({ phase: 'child-ready', errorClass: 'timeout', code: null });
  });

  it('cannot report success when only cleanup fails', async () => {
    const phases = new PhaseEvidence();
    let result: LifecycleResult | undefined;
    const failure = new Error('owned cleanup failed');
    await expect(runCrashLifecycle(async () => true, async () => { throw failure; },
      async value => { result = value; }, phases)).rejects.toThrow('owned crash scenario failed');
    expect(result).toMatchObject({ success: false, cleanupFailure: { phase: 'cleanup', errorClass: 'operation' } });
  });
});
