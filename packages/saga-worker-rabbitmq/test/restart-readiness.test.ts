import { BrokerGate } from '../integration/rabbitAppReady';
import { BrokerUnavailableError, phaseStep, PHASE_MARKER } from '../integration/topologyPhase';

describe('negative-case broker gate after restart', () => {
  it('blocks negative cases when app becomes ready but AMQP cannot open after restart', async () => {
    const gate = new BrokerGate();
    const sequence: string[] = [];
    await expect(gate.afterRestart(async () => { sequence.push('restart'); },
      async () => { sequence.push('app-ready'); },
      async () => { sequence.push('amqp-failed'); const failure = Object.assign(new Error('amqp://user:pass@host'), { code: 'ECONNREFUSED' });
        gate.recordAmqpFailure(failure); throw failure; }))
      .rejects.toMatchObject({ message: 'broker restart unavailable', restartEvidence: {
        restartSubphase: 'amqp-connect', restartDocker: true, restartApp: true, restartAmqp: false,
        amqpErrorClass: 'ECONNREFUSED', amqpCode: null
      } });
    const check = jest.fn(async () => { sequence.push('negative-check'); });
    await expect(phaseStep('mismatch-setup', 'broker-available', () => gate.beforeNegative(check)))
      .rejects.toThrow(PHASE_MARKER);
    expect(check).not.toHaveBeenCalled();
    expect(sequence).toEqual(['restart', 'app-ready', 'amqp-failed']);
    expect(gate.evidence.amqpErrorClass).toBe('ECONNREFUSED');
  });

  it('fails closed before negative setup if the app becomes unavailable', async () => {
    const gate = new BrokerGate();
    await expect(gate.beforeNegative(async () => { throw new Error('not running'); })).rejects.toBeInstanceOf(BrokerUnavailableError);
    const setup = jest.fn(async () => undefined);
    await expect(gate.beforeNegative(setup)).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(setup).not.toHaveBeenCalled();
  });

  it('records the app-ready subphase when restart succeeds but app does not start', async () => {
    const gate = new BrokerGate();
    await expect(gate.afterRestart(async () => undefined, async () => { throw new Error('app deadline'); },
      async () => { throw new Error('must not attempt AMQP'); })).rejects.toMatchObject({
      restartEvidence: { restartSubphase: 'app-ready', restartDocker: true, restartApp: false, restartAmqp: false }
    });
    await expect(gate.beforeNegative(async () => undefined)).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it.each([
    ['ETIMEDOUT', Object.assign(new Error('amqp://user:pass@host timed out'), { code: 'ETIMEDOUT' }), null],
    ['ACCESS_REFUSED', Object.assign(new Error('Basic auth'), { code: 403 }), 403],
    ['auth-failure', new Error('login authentication failed amqp://user:pass@host'), null],
    ['channel-close', new Error('channel closed Basic private'), null]
  ])('allowlists %s without keeping AMQP credentials', (expected, error, code) => {
    const gate = new BrokerGate();
    gate.recordAmqpFailure(error);
    expect(gate.evidence.amqpErrorClass).toBe(expected);
    expect(gate.evidence.amqpCode).toBe(code);
    expect(JSON.stringify(gate.evidence)).not.toMatch(/user:pass|Basic|private/);
  });

  it.each([
    [{ code: 530 }, 530, 'unknown'],
    [{ code: 'bad', replyCode: 404 }, 404, 'unknown'],
    [{ code: 403 }, 403, 'ACCESS_REFUSED'],
    [{ code: -1 }, null, 'unknown'],
    [{ code: 1000 }, null, 'unknown'],
    [{ code: 4.5 }, null, 'unknown'],
    [{ code: Number.NaN }, null, 'unknown'],
    [{ code: '530' }, null, 'unknown'],
    [{ code: 1.5, replyCode: 404 }, 404, 'unknown']
  ])('bounds AMQP code %j while retaining safe numeric replyCode', (codes, expected, errorClass) => {
    const gate = new BrokerGate();
    gate.recordAmqpFailure(Object.assign(new Error('amqp://user:pass@host Basic c2VjcmV0'), codes));
    expect(gate.evidence.amqpCode).toBe(expected);
    expect(gate.evidence.amqpErrorClass).toBe(errorClass);
    expect(JSON.stringify(gate.evidence)).not.toMatch(/user:pass|Basic|c2VjcmV0/);
  });
});
