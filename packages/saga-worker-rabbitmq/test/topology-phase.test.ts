import { phaseStep, PHASE_MARKER, SafePhaseError, safePhaseFailure } from '../integration/topologyPhase';

function decode(error: SafePhaseError): Record<string, unknown> {
  return JSON.parse(Buffer.from(error.message.slice(PHASE_MARKER.length), 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('safe topology phase markers', () => {
  it('wraps timeouts with fixed phase/invariant and source line, not the dynamic queue or secret', async () => {
    let thrown: unknown;
    try {
      await phaseStep('held-unack', 'held-unack-one', async () => {
        throw new Error('queue topology-secret timed out amqp://user:pass@host Basic c2VjcmV0');
      });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(SafePhaseError);
    const safe = thrown as SafePhaseError;
    expect(decode(safe)).toMatchObject({ phase: 'held-unack', invariant: 'held-unack-one', errorClass: 'timeout',
      source: 'integration/topology-real.integration.test.ts', code: null, expected: null, actual: null });
    expect(typeof decode(safe).line).toBe('number');
    expect(JSON.stringify(safe)).not.toMatch(/topology-secret|user:pass|c2VjcmV0/);
  });

  it('retains numeric expected/actual reply codes through nested causes without raw credentials', () => {
    const cause = Object.assign(new Error('topology_restricted_password'), { code: 403 });
    const error = Object.assign(new Error('Basic c2VjcmV0'), { cause, expectedCode: 406, actualCode: 403, replyCode: 403 });
    const safe = safePhaseFailure('mismatch-reply-406', 'reply-code-406', error);
    expect(decode(safe)).toMatchObject({ errorClass: 'broker-reply', code: 403, replyCode: 403, expected: 406, actual: 403 });
    expect(safe.message).not.toMatch(/password|Basic|c2VjcmV0/);
  });

  it('does not overwrite an inner phase marker with an outer phase', async () => {
    await expect(phaseStep('setup-topology', 'declared-and-bound', () => phaseStep('inspect-topology', 'broker-inspected', async () => {
      throw new Error('secret private inspect');
    }))).rejects.toBeInstanceOf(SafePhaseError);
  });
});
