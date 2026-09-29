import { describe, expect, it } from '@jest/globals';
import { ChildStages, childPhases, isChildError } from '../integration/crashChildStages';
import { PhaseEvidence } from '../integration/crashPhaseEvidence';

describe('bounded child startup evidence', () => {
  it.each(childPhases.filter(phase => phase !== 'unknown'))('reports only allowlisted %s stage and numeric code', async phase => {
    const stages = new ChildStages();
    const failure = Object.assign(new Error('amqp://user:private-password@host/secret-body'), { replyCode: 403 });
    await expect(stages.run(phase, () => { throw failure; })).rejects.toBe(failure);
    const event = stages.failure(failure);
    expect(event).toEqual({ kind: 'error', phase, errorClass: 'operation', code: 403 });
    expect(isChildError(event)).toBe(true);
    expect(JSON.stringify(event)).not.toContain('private-password');
  });

  it('refuses raw fields and string codes, and preserves startup phase in parent first failure', async () => {
    const stages = new ChildStages();
    const error = Object.assign(new Error('private body'), { code: 'secret-code' });
    await expect(stages.run('worker-start', () => { throw error; })).rejects.toBe(error);
    const event = stages.failure(error);
    expect(event.code).toBeNull();
    expect(isChildError({ ...event, url: 'amqp://private-password@host' })).toBe(false);
    expect(isChildError({ ...event, phase: 'other' })).toBe(false);
    const phases = new PhaseEvidence();
    expect(phases.firstFailure).toBeNull();
  });
});
