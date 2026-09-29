import { phaseStep, PHASE_MARKER, PHASES, SafePhaseError, safePhaseFailure, withSafeClose } from '../integration/topologyPhase';
import { BrokerGate } from '../integration/rabbitAppReady';

function decode(error: SafePhaseError): Record<string, unknown> {
  return JSON.parse(Buffer.from(error.message.slice(PHASE_MARKER.length), 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('safe topology phase markers', () => {
  it.each(PHASES.filter((phase) => phase.startsWith('production-')))(
    'labels an injected %s failure without retaining publisher URI or credentials', async (phase) => {
      let caught: SafePhaseError | undefined;
      try {
        await phaseStep(phase, 'broker-available', async () => {
          throw Object.assign(new Error('amqp://user:pass@host Basic c2VjcmV0'), { code: 403 });
        });
      } catch (error) { caught = error as SafePhaseError; }
      expect(caught).toBeInstanceOf(SafePhaseError);
      expect(decode(caught as SafePhaseError)).toMatchObject({ phase, invariant: 'broker-available', code: 403 });
      expect(caught?.message).not.toMatch(/user:pass|Basic|c2VjcmV0/);
    }
  );

  it('keeps the first safe failure when resource close also fails, but reports close alone', async () => {
    const operation = () => phaseStep('production-publisher-publish', 'publisher-confirmed', async () => {
      throw new Error('amqp://user:pass@host publish failed');
    });
    const close = () => phaseStep('production-publisher-close', 'publisher-closed', async () => {
      throw new Error('Basic c2VjcmV0 close failed');
    });
    await expect(withSafeClose(operation, close)).rejects.toMatchObject({
      message: expect.stringContaining(PHASE_MARKER)
    });
    let caught: SafePhaseError | undefined;
    try { await withSafeClose(operation, close); } catch (error) { caught = error as SafePhaseError; }
    expect(decode(caught as SafePhaseError).phase).toBe('production-publisher-publish');
    try { await withSafeClose(async () => undefined, close); } catch (error) { caught = error as SafePhaseError; }
    expect(decode(caught as SafePhaseError).phase).toBe('production-publisher-close');
  });
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

  it('propagates the exact restart subphase to blocked negative markers without false reply assertions', async () => {
    const gate = new BrokerGate();
    await expect(gate.afterRestart(async () => undefined, async () => undefined, async () => {
      throw Object.assign(new Error('amqp://user:pass@host ACCESS_REFUSED'), { code: 403 });
    })).rejects.toThrow('broker restart unavailable');
    const restart = safePhaseFailure('broker-restart', 'same-volume-restarted',
      Object.assign(new Error('broker restart unavailable'), { restartEvidence: gate.evidence }));
    let blocked: SafePhaseError | undefined;
    try { await phaseStep('restricted-user-setup', 'broker-available', () => gate.beforeNegative(async () => undefined)); }
    catch (error) { blocked = error as SafePhaseError; }
    expect(blocked).toBeInstanceOf(SafePhaseError);
    expect(decode(blocked as SafePhaseError)).toMatchObject({ phase: 'restricted-user-setup',
      errorClass: 'blocked_on_broker_unavailable', code: null, expected: null, actual: null,
      restartSubphase: 'amqp-connect', restartDocker: true, restartApp: true, restartAmqp: false,
      amqpErrorClass: 'ACCESS_REFUSED', amqpCode: 403 });
    expect(decode(restart).restartSubphase).toEqual(decode(blocked as SafePhaseError).restartSubphase);
    expect(blocked?.message).not.toMatch(/user:pass|ACCESS_REFUSED.*host/);
  });

  it.each([530, 404, 403, 0, 999, -1, 1000, 2.5, Number.NaN, '530'])
  ('encodes only bounded numeric AMQP codes (%s) without raw failure text', (code) => {
    const error = Object.assign(new Error('amqp://user:pass@host Basic c2VjcmV0'), {
      restartEvidence: { restartSubphase: 'amqp-connect', restartDocker: true, restartApp: true,
        restartAmqp: false, amqpErrorClass: 'unknown', amqpCode: code }
    });
    const safe = safePhaseFailure('broker-restart', 'same-volume-restarted', error);
    expect(decode(safe).amqpCode).toBe(typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 999 ? code : null);
    expect(safe.message).not.toMatch(/user:pass|Basic|c2VjcmV0/);
  });
});
