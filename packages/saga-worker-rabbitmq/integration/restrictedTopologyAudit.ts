import type { Channel, ChannelModel } from 'amqplib';
import { expectBrokerRejection } from './topologyAudit';
import { phaseStep, withSafeClose } from './topologyPhase';

const BUDGET = { health: 6_000, connect: 4_000, channel: 3_000, reply: 4_000, close: 2_000 } as const;

/** A timed-out open may still resolve; dispose that late resource without exposing its error. */
export async function boundedRestricted<T>(
  operation: () => Promise<T>, ms: number, disposeLate?: (value: T) => Promise<unknown>
): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const task = Promise.resolve().then(operation);
  void task.then((value) => {
    if (timedOut && disposeLate) void Promise.resolve().then(() => disposeLate(value)).catch(() => undefined);
  }, () => undefined);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new Error('restricted step timed out')); }, ms);
  });
  try { return await Promise.race([task, deadline]); }
  finally { if (timer) clearTimeout(timer); }
}

export async function qualifyRestrictedTopology(options: {
  readonly health: () => Promise<void>;
  readonly connect: () => Promise<ChannelModel>;
  readonly provision: (channel: Channel) => Promise<void>;
}): Promise<void> {
  await phaseStep('restricted-health', 'broker-available', () => boundedRestricted(options.health, BUDGET.health));
  const model = await phaseStep('restricted-connect', 'restricted-channel', () =>
    boundedRestricted(options.connect, BUDGET.connect, (late) => late.close()));
  await withSafeClose(async () => {
    const channel = await phaseStep('restricted-channel', 'restricted-channel', () =>
      boundedRestricted(() => model.createChannel(), BUDGET.channel, (late) => late.close()));
    const consume = jest.spyOn(channel, 'consume');
    await phaseStep('restricted-reply-403', 'reply-code-403', () =>
      boundedRestricted(() => expectBrokerRejection(channel, () => options.provision(channel), 403), BUDGET.reply));
    expect(consume).not.toHaveBeenCalled();
  }, () => phaseStep('restricted-close', 'channel-closed', () => boundedRestricted(() => model.close(), BUDGET.close)));
}
