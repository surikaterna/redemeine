import { QueueMetricsError, type QueueCounts } from './crashBroker';

export type CountSample = { elapsedMs: number; inputAvailable: boolean; retryAvailable: boolean;
  input?: QueueCounts; retry?: QueueCounts; failure?: 'invalid_metrics' | 'unavailable' };

export const observationWindowMs = 10_000; // Stop before the independently configured 12s retry TTL.
const sampleLimit = 12;

function bounded(value: number): number {
  return Math.min(value, 1_000_000);
}

export function safeCounts(value: QueueCounts): QueueCounts {
  return { ready: bounded(value.ready), unacked: bounded(value.unacked), ack: bounded(value.ack) };
}

export function heldCopy(input: QueueCounts, retry: QueueCounts): boolean {
  return input.unacked === 1 && input.ack === 0 && retry.ready === 1;
}

export function requireKillProof(proof: { input: QueueCounts; retry: QueueCounts } | undefined,
  confirmedAt: number, now = Date.now): void {
  if (!proof || !heldCopy(proof.input, proof.retry) || now() - confirmedAt >= observationWindowMs) {
    throw new Error('broker count proof unavailable or expired before kill');
  }
}

export async function observeHeldCopy(
  read: (queue: 'input' | 'retry') => Promise<QueueCounts>, samples: CountSample[], confirmedAt: number,
  now = Date.now, sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<{ input: QueueCounts; retry: QueueCounts }> {
  while (now() - confirmedAt < observationWindowMs) {
    const sample: CountSample = { elapsedMs: Math.max(0, Math.min(observationWindowMs, now() - confirmedAt)),
      inputAvailable: false, retryAvailable: false };
    try {
      const input = await read('input');
      sample.inputAvailable = true;
      sample.input = safeCounts(input);
      const retry = await read('retry');
      sample.retryAvailable = true;
      sample.retry = safeCounts(retry);
      if (samples.length < sampleLimit) samples.push(sample);
      else samples[sampleLimit - 1] = sample;
      if (heldCopy(input, retry) && now() - confirmedAt < observationWindowMs) return { input, retry };
    } catch (error) {
      sample.failure = error instanceof QueueMetricsError ? 'invalid_metrics' : 'unavailable';
      if (samples.length < sampleLimit) samples.push(sample);
      else samples[sampleLimit - 1] = sample;
      throw error;
    }
    await sleep(100);
  }
  throw new Error('broker count observation expired');
}
