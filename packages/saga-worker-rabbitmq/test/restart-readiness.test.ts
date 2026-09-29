import { BrokerGate } from '../integration/rabbitAppReady';
import { BrokerUnavailableError, phaseStep, PHASE_MARKER } from '../integration/topologyPhase';

describe('negative-case broker gate after restart', () => {
  it('blocks negative cases when app becomes ready but AMQP cannot open after restart', async () => {
    const gate = new BrokerGate();
    const sequence: string[] = [];
    await expect(gate.afterRestart(async () => { sequence.push('restart'); },
      async () => { sequence.push('app-ready'); },
      async () => { sequence.push('amqp-failed'); throw new Error('amqp://user:pass@host unavailable'); }))
      .rejects.toThrow('amqp://user:pass@host unavailable');
    const check = jest.fn(async () => { sequence.push('negative-check'); });
    await expect(phaseStep('mismatch-setup', 'broker-available', () => gate.beforeNegative(check)))
      .rejects.toThrow(PHASE_MARKER);
    expect(check).not.toHaveBeenCalled();
    expect(sequence).toEqual(['restart', 'app-ready', 'amqp-failed']);
  });

  it('fails closed before negative setup if the app becomes unavailable', async () => {
    const gate = new BrokerGate();
    await expect(gate.beforeNegative(async () => { throw new Error('not running'); })).rejects.toBeInstanceOf(BrokerUnavailableError);
    const setup = jest.fn(async () => undefined);
    await expect(gate.beforeNegative(setup)).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(setup).not.toHaveBeenCalled();
  });
});
