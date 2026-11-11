import { verifyMalformedRetention, type MalformedPort } from '../integration/malformedRetention';
import { budgets } from '../integration/plan';
import { deferred } from './support/deferred';
import type { MalformedPublication } from '../integration/transportFaults';

type Operation = 'queue' | 'ready' | 'live' | 'control' | 'publish' | 'stop' | 'observe';
function fixture(late?: { operation: Operation; occurrence: number }) {
  let clock = 0; let published = false; const calls: Partial<Record<Operation, number>> = {};
  const tick = (operation: Operation) => {
    calls[operation] = (calls[operation] ?? 0) + 1;
    if (operation === late?.operation && calls[operation] === late.occurrence) clock = budgets.scenarioMs;
  };
  const port: MalformedPort = {
    queue: async () => { tick('queue'); return { messages_ready: published ? 1 : 0, messages_unacknowledged: 0, message_stats: { ack: 9 }, consumer_details: [] }; },
    health: async (path) => { tick(path === '/live' ? 'live' : 'ready'); return { status: path === '/live' ? 200 : 503,
      body: { phase: 'paused', reason: 'worker_paused', liveConsumerReady: false } }; },
    control: async () => { tick('control'); return { runState: 'active' }; },
    publish: async (): Promise<MalformedPublication> => { tick('publish'); published = true;
      return { messageIdHash: 'a'.repeat(64), sourceIdHash: 'b'.repeat(64), payloadKind: 'fixed_invalid_json', confirmRouted: true }; },
    stop: async () => { tick('stop'); return 0; }, observe: async () => { tick('observe'); }
  };
  return { port, calls, now: () => clock, advance: (value: number) => { clock += value; } };
}
afterEach(() => { jest.useRealTimers(); });

test('R10.1 Auditor cumulative sixty-second success probe refuses at the first elapsed await', async () => {
  const f = fixture(); const queue = f.port.queue; const health = f.port.health; const publish = f.port.publish; let published = false;
  f.port.queue = async (signal) => { f.advance(published ? 6000 : 10000); return queue(signal); };
  f.port.health = async (path, signal) => { f.advance(5000); return health(path, signal); };
  f.port.publish = async (signal) => { f.advance(10000); published = true; return publish(signal); };
  await expect(verifyMalformedRetention(f.port, new AbortController().signal, { now: f.now })).rejects.toThrow('qualification_condition_deadline');
  expect(f.now()).toBe(31000); expect(f.calls.stop).toBeUndefined();
});

const lateOperations: Array<{ operation: Operation; occurrence: number }> = [
  { operation: 'queue', occurrence: 1 }, { operation: 'observe', occurrence: 1 }, { operation: 'publish', occurrence: 1 },
  { operation: 'ready', occurrence: 1 }, { operation: 'queue', occurrence: 2 }, { operation: 'queue', occurrence: 3 },
  { operation: 'observe', occurrence: 4 }, { operation: 'live', occurrence: 1 }, { operation: 'queue', occurrence: 4 },
  { operation: 'control', occurrence: 1 }, { operation: 'stop', occurrence: 1 }, { operation: 'queue', occurrence: 5 },
  { operation: 'queue', occurrence: 6 }, { operation: 'observe', occurrence: 6 }, { operation: 'control', occurrence: 2 }
];
test.each(lateOperations)('late $operation occurrence $occurrence cannot succeed even with a delayed timer', async (late) => {
  const f = fixture(late);
  await expect(verifyMalformedRetention(f.port, new AbortController().signal, { now: f.now })).rejects.toThrow('qualification_condition_deadline');
  expect(f.now()).toBe(budgets.scenarioMs);
});

test.each(['queue', 'stop'] as const)('stuck %s is independently raced, marked unjoined, aborted locally and late rejection observed', async (operation) => {
  jest.useFakeTimers(); const f = fixture(); const pending = deferred<never>(); const labels: string[] = [];
  const parent = new AbortController(); let childSignal: AbortSignal | undefined;
  f.port[operation] = async (signal) => { childSignal = signal; return pending.promise; };
  const result = verifyMalformedRetention(f.port, parent.signal, { now: f.now, unjoined: (label) => labels.push(label) }).catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(budgets.scenarioMs);
  expect(await result).toMatchObject({ reason: 'qualification_condition_deadline' });
  expect(labels).toContain(`malformed_${operation}`); expect(childSignal?.aborted).toBe(true); expect(parent.signal.aborted).toBe(false);
  pending.reject(new Error('late-private-error')); await jest.advanceTimersByTimeAsync(0); expect(jest.getTimerCount()).toBe(0);
});

test('parent abort settles a stuck operation without a late success or reporter-error leak', async () => {
  const f = fixture(); const pending = deferred<unknown>(); const parent = new AbortController(); let childSignal: AbortSignal | undefined;
  f.port.queue = async (signal) => { childSignal = signal; return pending.promise; };
  const result = verifyMalformedRetention(f.port, parent.signal, { unjoined: () => { throw new Error('sink-failed'); } }).catch((error: unknown) => error);
  await new Promise(setImmediate); parent.abort(); expect(await result).toMatchObject({ reason: 'qualification_stopping' });
  expect(childSignal?.aborted).toBe(true); pending.resolve({}); await new Promise(setImmediate);
  expect(f.calls.publish).toBeUndefined();
});
