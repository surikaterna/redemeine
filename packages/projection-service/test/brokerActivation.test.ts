import { brokerResourceFactory } from '../src/infrastructure/brokerRuntime';
import { Observations } from '../src/observability';
import { SessionFence } from '../src/sessionFence';
import { builtArtifact } from './fixtures';
import { brokerClients } from './support/brokerClients';
import { deferred, until } from './support/deferred';
import { object, list } from '../src/infrastructure/brokerSchema';
import { startupFacts } from '../integration/startupEvidence';
import { sanitizedLogs } from '../integration/receipts';

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test('consume-ok absent->zero->one count with empty details holds original F42 until exact active identity', async () => {
  const f = brokerClients(); f.early(); const observations = new Observations(undefined, 'external');
  const fence = new SessionFence();
  const resource = await brokerResourceFactory(f.mongo.config, await builtArtifact(), observations, f.factories)(new AbortController().signal, fence);
  const native = f.connections[0]?.channel; if (!native) throw new Error('missing_channel');
  const consume = native.consume.getMockImplementation(); if (!consume) throw new Error('missing_consume');
  let details: unknown;
  native.consume.mockImplementation(async (...args) => {
    const result = await consume(...args); const queue = object(f.management.queueValue);
    details = queue.consumer_details; queue.consumer_details = []; delete queue.consumers; return result;
  });
  const starting = resource.start(); void starting.catch(() => {});
  try {
    await until(() => details !== undefined && observations.snapshot(false).startupConsumerDetailsCount === 0);
    expect(resource.worker.getStatus().accepting).toBe(false); expect(f.data.trace).not.toContain('floor:admit');
    expect(f.data.trace).not.toContain('document'); expect(native.ack).not.toHaveBeenCalled();
    const absent = startupFacts(observations.snapshot(false));
    expect(absent).toMatchObject({ startupConsumerDetailsCount: 0, startupQueueConsumerCountShape: 'absent' });
    expect(absent).not.toHaveProperty('startupQueueConsumerCount');
    const queue = object(f.management.queueValue); queue.consumers = 0;
    await until(() => observations.snapshot(false).startupQueueConsumerCount === 0);
    expect(startupFacts(observations.snapshot(false))).toMatchObject({ startupQueueConsumerCount: 0 });
    queue.consumers = 1; await until(() => observations.snapshot(false).startupQueueConsumerCount === 1);
    expect(startupFacts(observations.snapshot(false))).toMatchObject({ startupConsumerDetailsCount: 0, startupQueueConsumerCount: 1 });
    expect(resource.worker.getStatus().accepting).toBe(false); expect(f.data.trace).not.toContain('floor:admit');
    expect(f.data.trace).not.toContain('document'); expect(native.ack).not.toHaveBeenCalled();
    queue.consumer_details = details;
    await starting; await until(() => resource.worker.getStatus().activeDeliveries === 0);
    expect(resource.worker.getStatus().accepting).toBe(true); expect(native.ack).toHaveBeenCalledWith(f.message, false);
    expect(f.data.trace.indexOf('floor:42')).toBeLessThan(f.data.trace.indexOf('ack'));
    expect([...f.data.rows.values()].filter((row) => row.state && typeof row.state === 'object').map((row) => row.state)).toEqual([{ count: 5 }, { count: 5 }]);
  } finally {
    fence.stop(); await resource.worker.stop(); await starting.catch(() => {}); await resource.close();
  }
});

test('shutdown during unknown-count staging wins without admission or a clean restart marker', async () => {
  const f = brokerClients(); f.early(); const controller = new AbortController(); const fence = new SessionFence();
  const resource = await brokerResourceFactory(f.mongo.config, await builtArtifact(), new Observations(), f.factories)(controller.signal, fence);
  const native = f.connections[0]?.channel; if (!native) throw new Error('missing_channel');
  const consume = native.consume.getMockImplementation(); if (!consume) throw new Error('missing_consume');
  native.consume.mockImplementation(async (...args) => {
    const result = await consume(...args); const queue = object(f.management.queueValue); queue.consumer_details = []; delete queue.consumers; return result;
  });
  jest.useFakeTimers(); const result = resource.start().catch((error: unknown) => error); await jest.advanceTimersByTimeAsync(100);
  controller.abort(); fence.stop(); await resource.worker.stop(); expect(await result).toMatchObject({ message: 'live_start_unproven' });
  await resource.close(); expect(f.data.trace).not.toContain('floor:admit'); expect(native.ack).not.toHaveBeenCalled();
  expect([...f.data.rows.values()].find((row) => row.version === 1)?.runState).toBe('active'); expect(jest.getTimerCount()).toBe(0);
});

test('service preserves active-consumer mismatch before protected worker generic mapping and joins cleanup despite throwing sink', async () => {
  const f = brokerClients(); const observations = new Observations(undefined, 'external');
  const resource = await brokerResourceFactory(f.mongo.config, await builtArtifact(), observations, f.factories)(new AbortController().signal, new SessionFence());
  const native = f.connections[0]?.channel; if (!native) throw new Error('missing_channel');
  const consume = native.consume.getMockImplementation(); if (!consume) throw new Error('missing_consume');
  native.consume.mockImplementation(async (...args) => {
    const result = await consume(...args); object(list(object(f.management.queueValue).consumer_details)[0]).active = false; return result;
  });
  const seen: unknown[] = []; const startup = observations.startup.bind(observations);
  jest.spyOn(observations, 'startup').mockImplementation((stage, error) => { startup(stage, error); if (error) seen.push(error); throw new Error('sink-secret'); });
  await expect(resource.start()).rejects.toThrow('live_start_unproven');
  expect(seen.some((error) => error instanceof Error && error.message === 'broker_consumer_active_mismatch')).toBe(true);
  expect(startupFacts(observations.snapshot(false))).toMatchObject({ stage: 'consumer_start', code: 'broker_consumer_active_mismatch',
    startupConsumerDetailsCount: 1, startupConsumerActive: false, startupConsumerTagMatches: true });
  expect(sanitizedLogs(JSON.stringify(observations.snapshot(false)))).toContain('broker_consumer_active_mismatch');
  expect(JSON.stringify(observations.snapshot(false))).not.toContain('sink-secret');
  const closing = deferred<void>(); f.connections[0]?.close.mockImplementation(() => closing.promise); let closed = false;
  await resource.worker.stop(); const done = resource.close().then(() => { closed = true; });
  await new Promise(setImmediate); expect(closed).toBe(false); closing.resolve(); await done;
  expect(f.connections[0]?.close).toHaveBeenCalledTimes(1); expect(f.data.trace).not.toContain('floor:admit');
});
