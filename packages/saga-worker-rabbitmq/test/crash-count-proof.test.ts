import { describe, expect, it, jest } from '@jest/globals';
import { parseQueueCounts, type QueueCounts } from '../integration/crashBroker';
import { heldCopy, observationWindowMs, observeHeldCopy, requireKillProof,
  type CountSample } from '../integration/crashCountProof';

const input: QueueCounts = { ready: 0, unacked: 1, ack: 0 };
const retry: QueueCounts = { ready: 1, unacked: 0, ack: 0 };

describe('management counts', () => {
  it('accepts fresh queues with absent stats only when both counts are valid', () => {
    expect(parseQueueCounts({ messages_ready: 1, messages_unacknowledged: 0 })).toEqual(retry);
    for (const value of [{ messages_ready: 1 }, { messages_unacknowledged: 0 },
      { messages_ready: 1, messages_unacknowledged: -1 },
      { messages_ready: NaN, messages_unacknowledged: 0 },
      { messages_ready: 1.2, messages_unacknowledged: 0 },
      { messages_ready: 1, messages_unacknowledged: Infinity }, null]) {
      expect(() => parseQueueCounts(value)).toThrow();
    }
  });

  it('rejects malformed present stats or ACK and accepts a valid present ACK', () => {
    for (const stats of [null, undefined, [], 3, { ack: '0' }, { ack: -1 },
      { ack: NaN }, { ack: 0.5 }, { ack: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(() => parseQueueCounts({ messages_ready: 1, messages_unacknowledged: 0,
        message_stats: stats })).toThrow();
    }
    expect(parseQueueCounts({ messages_ready: 1, messages_unacknowledged: 0, message_stats: {} })).toEqual(retry);
    expect(parseQueueCounts({ messages_ready: 1, messages_unacknowledged: 0, message_stats: { ack: 2 } }).ack).toBe(2);
  });
});

describe('kill eligibility', () => {
  it('requires simultaneous held original, zero input ACK and ready retry', () => {
    expect(heldCopy(input, retry)).toBe(true);
    for (const [a, b] of [[{ ...input, unacked: 0 }, retry], [{ ...input, ack: 1 }, retry],
      [input, { ...retry, ready: 0 }]] as const) expect(heldCopy(a, b)).toBe(false);
  });

  it('does not enter the kill path with missing, lagging or expired broker proof', () => {
    const kill = jest.fn();
    for (const proof of [undefined, { input: { ...input, unacked: 0 }, retry },
      { input: { ...input, ack: 1 }, retry }, { input, retry: { ...retry, ready: 0 } }]) {
      expect(() => { requireKillProof(proof, 0, () => 1); kill(); }).toThrow();
    }
    expect(() => { requireKillProof({ input, retry }, 0, () => observationWindowMs); kill(); }).toThrow();
    expect(kill).not.toHaveBeenCalled();
    requireKillProof({ input, retry }, 0, () => observationWindowMs - 1);
  });

  it('waits for lag, records bounded samples, and never uses a consuming get', async () => {
    let time = 0;
    let polls = 0;
    const samples: CountSample[] = [];
    const read = jest.fn(async (queue: 'input' | 'retry') => {
      if (queue === 'input') return input;
      return { ...retry, ready: ++polls >= 3 ? 1 : 0 };
    });
    expect(await observeHeldCopy(read, samples, 0, () => time, async ms => { time += ms; })).toEqual({ input, retry });
    expect(samples).toHaveLength(3);
    expect(samples.map(s => s.elapsedMs)).toEqual([0, 100, 200]);
    expect(samples.every(s => s.inputAvailable && s.retryAvailable)).toBe(true);
    expect(read).toHaveBeenCalledTimes(6);
  });

  it('expires before the 12s TTL without a proof or indefinite polling', async () => {
    let time = 0;
    const samples: CountSample[] = [];
    await expect(observeHeldCopy(async queue => queue === 'input' ? input : { ...retry, ready: 0 },
      samples, 0, () => time, async ms => { time += ms; })).rejects.toThrow('expired');
    expect(time).toBe(observationWindowMs);
    expect(samples.length).toBeLessThanOrEqual(12);
    expect(samples.at(-1)?.elapsedMs).toBeLessThan(observationWindowMs);
  });

  it('fails closed on unavailable or malformed counts and bounds numeric receipt values', async () => {
    const unavailable: CountSample[] = [];
    await expect(observeHeldCopy(async () => { throw new Error('secret'); }, unavailable, 0, () => 0))
      .rejects.toThrow('secret');
    expect(unavailable).toEqual([{ elapsedMs: 0, inputAvailable: false, retryAvailable: false,
      failure: 'unavailable' }]);
    const partial: CountSample[] = [];
    await expect(observeHeldCopy(async queue => queue === 'input' ? input : Promise.reject(new Error('bad')),
      partial, 0, () => 0)).rejects.toThrow('bad');
    expect(partial[0]).toMatchObject({ inputAvailable: true, retryAvailable: false });
    const malformed: CountSample[] = [];
    await expect(observeHeldCopy(async queue => queue === 'input' ? input :
      parseQueueCounts({ messages_ready: 1 }), malformed, 0, () => 0)).rejects.toThrow();
    expect(malformed).toEqual([{ elapsedMs: 0, inputAvailable: true, retryAvailable: false,
      input, failure: 'invalid_metrics' }]);
    const huge: CountSample[] = [];
    await expect(observeHeldCopy(async queue => queue === 'input' ? { ...input, ready: Number.MAX_SAFE_INTEGER } : retry,
      huge, 0, () => observationWindowMs)).rejects.toThrow('expired');
    expect(huge).toEqual([]);
    let time = 0;
    await observeHeldCopy(async queue => queue === 'input' ? { ...input, ready: Number.MAX_SAFE_INTEGER } : retry,
      huge, 0, () => time, async () => { time = observationWindowMs; });
    expect(huge[0]?.input?.ready).toBe(1_000_000);
  });
});
