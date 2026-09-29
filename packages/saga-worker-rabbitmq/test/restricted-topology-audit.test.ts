import { EventEmitter } from 'node:events';
import type { Channel, ChannelModel } from 'amqplib';
import { boundedRestricted, qualifyRestrictedTopology } from '../integration/restrictedTopologyAudit';
import { phaseStep, PHASE_MARKER, SafePhaseError } from '../integration/topologyPhase';

function marker(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(SafePhaseError);
  const text = (error as SafePhaseError).message;
  expect(text).not.toMatch(/topology_restricted_password|user:pass|Basic c2VjcmV0/);
  return JSON.parse(Buffer.from(text.slice(PHASE_MARKER.length), 'base64url').toString('utf8')) as Record<string, unknown>;
}

function fixture(reply: number | null, health = async () => undefined) {
  const channel = Object.assign(new EventEmitter(), { consume: jest.fn() }) as unknown as Channel;
  const close = jest.fn(async () => undefined);
  const model = { createChannel: async () => channel, close } as unknown as ChannelModel;
  const provision = async () => {
    if (reply === null) return;
    const failure = Object.assign(new Error('amqp://user:pass@host topology_restricted_password'), { code: reply });
    channel.emit('error', failure);
    throw failure;
  };
  return { channel, close, model, provision, health };
}

describe('restricted owned Rabbit 403 audit', () => {
  it('permits slow healthy readiness and requires a real emitted 403 plus rejected declaration', async () => {
    const { channel, close, model, provision, health } = fixture(403, () =>
      new Promise((resolve) => setTimeout(resolve, 40)));
    await qualifyRestrictedTopology({ health, connect: async () => model, provision });
    expect(channel.consume).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('allows health beyond the former five-second Jest budget without weakening the 403 check', async () => {
    jest.useFakeTimers();
    try {
      const { channel, close, model, provision } = fixture(403);
      const health = () => new Promise<void>((resolve) => { setTimeout(resolve, 5_100); });
      const result = qualifyRestrictedTopology({ health, connect: async () => model, provision });
      await jest.advanceTimersByTimeAsync(5_100);
      await expect(result).resolves.toBeUndefined();
      expect(channel.consume).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it.each([null, 404])('fails closed when broker does not emit and reject 403 (%p)', async (reply) => {
    const { channel, close, model, provision, health } = fixture(reply);
    let failure: unknown;
    try { await qualifyRestrictedTopology({ health, connect: async () => model, provision }); }
    catch (error) { failure = error; }
    expect(marker(failure)).toMatchObject({ phase: 'restricted-reply-403', invariant: 'reply-code-403' });
    expect(channel.consume).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('times out a hung connect with sanitized phase and disposes a late model', async () => {
    let finish: ((model: ChannelModel) => void) | undefined;
    const close = jest.fn(async () => undefined);
    const pending = new Promise<ChannelModel>((resolve) => { finish = resolve; });
    const operation = () => boundedRestricted(() => pending, 10, (late) => late.close());
    let failure: unknown;
    try { await phaseStep('restricted-connect', 'restricted-channel', operation); }
    catch (error) { failure = error; }
    expect(marker(failure)).toMatchObject({ phase: 'restricted-connect', errorClass: 'timeout', code: null });
    finish?.({ close } as unknown as ChannelModel);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('disposes late channels and preserves first failure over close errors', async () => {
    const close = jest.fn(async () => undefined);
    let finish: ((channel: Channel) => void) | undefined;
    const pending = new Promise<Channel>((resolve) => { finish = resolve; });
    await expect(boundedRestricted(() => pending, 10, (late) => late.close())).rejects.toThrow('restricted step timed out');
    finish?.({ close } as unknown as Channel);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(close).toHaveBeenCalledTimes(1);
    const { model, close: modelClose, provision, health } = fixture(404);
    modelClose.mockRejectedValue(new Error('Basic c2VjcmV0 close failure'));
    let failure: unknown;
    try { await qualifyRestrictedTopology({ health, connect: async () => model, provision }); }
    catch (error) { failure = error; }
    expect(marker(failure)).toMatchObject({ phase: 'restricted-reply-403', expected: 403, actual: 404 });
  });
});
