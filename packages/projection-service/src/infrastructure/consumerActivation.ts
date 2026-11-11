import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { BrokerRefusal } from './brokerSchema';

async function poll(check: () => Promise<void>, assertCurrent: () => void, signal: AbortSignal,
  deadline: number, now: () => number): Promise<void> {
  while (!signal.aborted) {
    assertCurrent();
    if (now() >= deadline) throw new BrokerRefusal('broker_consumer_activation_deadline');
    try {
      await check();
      assertCurrent();
      if (signal.aborted) throw signal.reason;
      if (now() >= deadline) throw new BrokerRefusal('broker_consumer_activation_deadline');
      return;
    } catch (error) {
      if (!(error instanceof BrokerRefusal) || error.reason !== 'broker_consumer_count_pending') throw error;
    }
    await delay(Math.max(1, Math.min(100, deadline - now())), undefined, { signal });
  }
  throw signal.reason;
}

export async function waitForConsumerActivation(check: () => Promise<void>, assertCurrent: () => void,
  signal: AbortSignal, now: () => number = () => performance.now()): Promise<void> {
  const controller = new AbortController();
  const deadline = now() + 10000;
  const abort = () => controller.abort(new BrokerRefusal('broker_session_expired'));
  const interrupt = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const timer = setTimeout(() => controller.abort(new BrokerRefusal('broker_consumer_activation_deadline')), 10000);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try { await Promise.race([poll(check, assertCurrent, controller.signal, deadline, now), interrupt]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); abort(); }
}
