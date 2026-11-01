import { assertIsolated, assertRetained, verifyMalformedRetention, retentionFacts, type MalformedPort } from '../integration/malformedRetention';
import { budgets } from '../integration/plan';
import type { MalformedPublication } from '../integration/transportFaults';
import { EventEmitter } from 'node:events';
import { ProjectionHost } from '../src/host';
import { Observations } from '../src/observability';
import { brokerResourceFactory } from '../src/infrastructure/brokerRuntime';
import { brokerClients } from './support/brokerClients';
import { builtArtifact } from './fixtures';
import { until } from './support/deferred';
import { request } from './support/http';
import { record } from '../integration/schema';

const queue = (ready: number, unacked: number, ack = 9) => ({ messages_ready: ready, messages_unacknowledged: unacked, message_stats: { ack }, consumer_details: [] });
function fixture(retainedReady = 1) {
  let published = false; let stopped = false;
  const port: MalformedPort = { queue: jest.fn(async () => !published ? queue(0, 0) : queue(stopped ? 1 : retainedReady, stopped ? 0 : 1 - retainedReady)),
    health: jest.fn(async (path) => ({ status: path === '/live' ? 200 : 503, body: { phase: 'paused', reason: 'worker_paused', liveConsumerReady: false } })),
    control: jest.fn(async () => ({ runState: 'active' })), observe: jest.fn(async () => {}),
    publish: jest.fn(async (): Promise<MalformedPublication> => { published = true; return { messageIdHash: 'a'.repeat(64), sourceIdHash: 'b'.repeat(64), payloadKind: 'fixed_invalid_json', confirmRouted: true }; }),
    stop: jest.fn(async () => { stopped = true; return 0; }) };
  return port;
}
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test.each([0, 1])('one unACKed obligation retained with ready=%s passes; stop0 requeues it without ACK', async (ready) => {
  const port = fixture(ready); const result = await verifyMalformedRetention(port, new AbortController().signal);
  expect(result.paused).toEqual({ ready, unacked: 1 - ready, ack: 9 }); expect(result.afterStop).toEqual({ ready: 1, unacked: 0, ack: 9 });
  expect(result.noAckAtObservedPause).toBe(true); expect(result.durableRunQuarantined).toBe(true);
});

test.each([[0, 0, 9], [2, 0, 9], [1, 1, 9], [1, 0, 10]])('dropped/extra/ACKed obligations %p cannot pass', (ready, unacked, ack) => {
  expect(() => assertRetained(queue(ready, unacked, ack), 9)).toThrow();
});

test('queue must be empty before publish; no synthetic zero ACK/default fields', async () => {
  const port = fixture(); port.queue = async () => queue(1, 0);
  await expect(verifyMalformedRetention(port, new AbortController().signal)).rejects.toThrow('malformed_baseline_not_empty');
  expect(port.publish).not.toHaveBeenCalled(); expect(() => assertIsolated({ messages_ready: 0 })).toThrow();
});

test('ACK change observed during pause is an immediate refusal', async () => {
  const port = fixture(); let reads = 0; port.queue = async () => ++reads === 1 ? queue(0, 0) : queue(1, 0, 10);
  await expect(verifyMalformedRetention(port, new AbortController().signal)).rejects.toThrow('malformed_delivery_acked');
  expect(port.stop).not.toHaveBeenCalled();
});

test('ACK change after stop and clean control marker cannot authorize success', async () => {
  const port = fixture(); const original = port.queue; let stopped = false;
  port.stop = async () => { stopped = true; return 0; }; port.queue = async () => stopped ? queue(1, 0, 10) : original();
  await expect(verifyMalformedRetention(port, new AbortController().signal)).rejects.toThrow('malformed_delivery_acked');
  const clean = fixture(); clean.control = async () => ({ runState: 'clean' });
  await expect(verifyMalformedRetention(clean, new AbortController().signal)).rejects.toThrow('unsafe_clean_restart_marker');
});

test('zero/lost queue forever expires the existing budget instead of passing pause alone', async () => {
  jest.useFakeTimers(); const port = fixture(); port.queue = async () => queue(0, 0);
  const result = verifyMalformedRetention(port, new AbortController().signal).catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(budgets.scenarioMs + 100);
  expect(await result).toMatchObject({ reason: 'qualification_condition_deadline' });
});

test('snapshot facts preserve missing/malformed predicates without payload/URI/source values', () => {
  const facts = retentionFacts({ status: 503, body: { reason: 'amqp://secret', payload: 'source-secret' } },
    { messages_ready: 1, messages_unacknowledged: 'secret' });
  expect(facts).toMatchObject({ ready: { shape: 'integer', value: 1 }, unacked: { shape: 'invalid' }, ack: { shape: 'absent' }, reason: 'unknown' });
  expect(JSON.stringify(facts)).not.toMatch(/amqp|secret/);
});

test.each(['live_failed', 'stop_failed'])('%s cannot pass retained-message evidence', async (fault) => {
  const port = fixture();
  if (fault === 'live_failed') port.health = async (path) => ({ status: path === '/live' ? 500 : 503, body: { phase: 'paused', reason: 'worker_paused', liveConsumerReady: false } });
  else port.stop = async () => 124;
  await expect(verifyMalformedRetention(port, new AbortController().signal)).rejects.toThrow(fault === 'live_failed' ? 'paused_host_not_live' : 'paused_shutdown_failed');
});

test('active control must remain quarantined after successful stop too', async () => {
  const port = fixture(); let reads = 0; port.control = async () => ({ runState: ++reads === 1 ? 'active' : 'clean' });
  await expect(verifyMalformedRetention(port, new AbortController().signal)).rejects.toThrow('unsafe_clean_restart_marker');
});

test('post-stop stale consumer metadata remains unproven until actual idle-list observation within the same budget', async () => {
  const port = fixture(); const original = port.queue; let stopped = false; let samples = 0;
  const stop = port.stop; port.stop = async () => { stopped = true; return stop(); };
  port.queue = async () => ({ ...record(await original()), consumer_details: stopped && ++samples < 3 ? [{}] : [] });
  const result = await verifyMalformedRetention(port, new AbortController().signal);
  expect(samples).toBeGreaterThanOrEqual(3); expect(result.afterStop).toEqual({ ready: 1, unacked: 0, ack: 9 });
});

test('final post-stop readback must still be ready-only and idle, not merely one obligation', async () => {
  const port = fixture(); const original = port.queue; const stop = port.stop; let stopped = false; let reads = 0;
  port.stop = async () => { stopped = true; return stop(); };
  port.queue = async () => stopped && ++reads > 1 ? queue(0, 1) : original();
  await expect(verifyMalformedRetention(port, new AbortController().signal)).rejects.toThrow('malformed_stop_obligation_not_ready');
});

test('actual host pause joins native channel close, models broker requeue, stays live and retains active quarantine marker', async () => {
  const f = brokerClients(); const signals = new EventEmitter(); const observations = new Observations(undefined, 'external');
  const host = new ProjectionHost({ ...f.mongo.config, healthPort: 0 }, { signals, observations, forceExit: jest.fn(),
    acquire: async () => ({ close: async () => {} }), connect: brokerResourceFactory(f.mongo.config, await builtArtifact(), observations, f.factories) });
  const done = host.start();
  try {
    await until(() => host.snapshot().liveConsumerReady);
    const native = f.connections[0]?.channel; if (!native) throw new Error('missing_channel');
    let ready = 0; let unacked = 0;
    const close = native.close.getMockImplementation(); if (!close) throw new Error('missing_close');
    native.close.mockImplementation(async () => { ready += unacked; unacked = 0; await close(); });
    const port: MalformedPort = { queue: async () => queue(ready, unacked, native.ack.mock.calls.length),
      health: async (path = '/ready') => { const response = await request(host.healthPort, path); return { status: response.status, body: JSON.parse(response.text) }; },
      control: async () => ({ runState: String([...f.data.rows.values()].find((row) => row.version === 1)?.runState) }),
      observe: async () => {}, publish: async () => {
        unacked = 1; native.handler?.({ ...f.message, content: Buffer.from('not-a-json-commit') });
        return { messageIdHash: 'a'.repeat(64), sourceIdHash: 'b'.repeat(64), payloadKind: 'fixed_invalid_json', confirmRouted: true };
      }, stop: async () => { signals.emit('SIGTERM'); return done; } };
    const result = await verifyMalformedRetention(port, new AbortController().signal);
    expect(result.paused).toEqual({ ready: 1, unacked: 0, ack: 0 }); expect(result.afterStop).toEqual(result.paused);
    expect(native.close).toHaveBeenCalledTimes(1); expect(native.ack).not.toHaveBeenCalled();
    expect(f.data.trace).not.toContain('floor:admit'); expect(f.data.trace).not.toContain('document');
  } finally { signals.emit('SIGTERM'); await done; }
});
