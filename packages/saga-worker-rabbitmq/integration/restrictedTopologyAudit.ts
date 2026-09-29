import type { Channel, ChannelModel } from 'amqplib';
import { expectBrokerRejection } from './topologyAudit';
import { phaseStep, withSafeClose } from './topologyPhase';

const BUDGET = { health: 6_000, connect: 4_000, channel: 3_000, reply: 4_000, close: 2_000 } as const;

/** A timed-out open may still resolve; dispose that late resource without exposing its error. */
export async function boundedRestricted<T>(
  operation: () => Promise<T>, ms: number, disposeLate?: (value: T) => Promise<unknown>, onTimeout?: () => void
): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const task = Promise.resolve().then(operation);
  void task.then((value) => {
    if (timedOut && disposeLate) void Promise.resolve().then(() => disposeLate(value)).catch(() => undefined);
  }, () => undefined);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; onTimeout?.(); reject(new Error('restricted step timed out')); }, ms);
  });
  try { return await Promise.race([task, deadline]); }
  finally { if (timer) clearTimeout(timer); }
}

/** An error after observation times out is not another 403; contain it until channel close. */
export function containLateChannelError(channel: Pick<Channel, 'on' | 'off'>): () => void {
  const sink = () => undefined;
  const onClose = () => { channel.off('error', sink); channel.off('close', onClose); };
  channel.on('error', sink);
  channel.on('close', onClose);
  return onClose;
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
    containLateChannelError(channel);
    const consume = await phaseStep('restricted-channel', 'restricted-channel', async () => jest.spyOn(channel, 'consume'));
    const controller = new AbortController();
    try {
      await phaseStep('restricted-reply-403', 'reply-code-403', () => boundedRestricted(
        () => expectBrokerRejection(channel, () => options.provision(channel), 403, controller.signal),
        BUDGET.reply, undefined, () => controller.abort()
      ));
      await phaseStep('restricted-reply-403', 'reply-code-403', async () => { expect(consume).not.toHaveBeenCalled(); });
    } finally {
      if (controller.signal.aborted) {
        await boundedRestricted(() => channel.close(), 500).catch(() => undefined);
      }
    }
  }, () => phaseStep('restricted-close', 'channel-closed', () => boundedRestricted(() => model.close(), BUDGET.close)));
}
