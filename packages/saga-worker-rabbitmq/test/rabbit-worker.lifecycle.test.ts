import { describe, expect, it } from '@jest/globals';
import type { Replies } from 'amqplib';
import { createSagaRabbitWorker } from '../src/index';
import { deferred, FakeChannel, flush, limits, message, options, queue } from './helpers';

const noRoutes = async () => [] as const;

describe('Rabbit saga worker lifecycle', () => {
  it('asserts DLX and queue topology, then applies exact prefetch before consuming', async () => {
    const channel = new FakeChannel();
    const target = createSagaRabbitWorker(options(channel, noRoutes));

    await expect(target.start()).resolves.toBe('consumer-1');

    expect(channel.calls).toEqual([
      'exchange:saga-turns.dlx:direct:true',
      `queue:saga-turns:${JSON.stringify(queue.options)}`,
      'prefetch:2:false',
      'consume:saga-turns'
    ]);
    expect(channel.consumeCalls[0]?.options).toEqual({ noAck: false });
    expect(target.state).toBe('running');
  });

  it('does not prefetch or consume when topology assertion fails', async () => {
    const channel = new FakeChannel();
    channel.assertQueueError = new Error('inequivalent queue arguments');
    const target = createSagaRabbitWorker(options(channel, noRoutes));

    await expect(target.start()).rejects.toThrow('inequivalent queue arguments');
    expect(channel.calls).toEqual(['exchange:saga-turns.dlx:direct:true', `queue:saga-turns:${JSON.stringify(queue.options)}`]);
    expect(target.state).toBe('stopped');
  });

  it('validates positive bounds and topology consistency before broker calls', async () => {
    const channel = new FakeChannel();
    const invalidLimits = { ...limits, prefetch: 0 };
    const target = createSagaRabbitWorker(options(channel, noRoutes, [], { limits: invalidLimits }));
    await expect(target.start()).rejects.toThrow('prefetch must be a positive integer');
    expect(channel.calls).toHaveLength(0);
  });

  it('shares concurrent starts and registers one consumer', async () => {
    const channel = new FakeChannel();
    const consume = deferred<Replies.Consume>();
    channel.consumeResult = consume.promise;
    const target = createSagaRabbitWorker(options(channel, noRoutes));

    const first = target.start();
    const second = target.start();
    expect(first).toBe(second);
    await flush();
    expect(channel.consumeCalls).toHaveLength(1);
    consume.resolve({ consumerTag: 'shared' });
    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared']);
  });

  it('cancels exactly once when stopped during consume startup', async () => {
    const channel = new FakeChannel();
    const consume = deferred<Replies.Consume>();
    channel.consumeResult = consume.promise;
    const target = createSagaRabbitWorker(options(channel, noRoutes));

    const starting = target.start();
    await flush();
    const stopping = target.stop();
    expect(target.state).toBe('stopping');
    consume.resolve({ consumerTag: 'late-consumer' });

    await expect(starting).rejects.toThrow('interrupted');
    await expect(stopping).resolves.toBeUndefined();
    expect(channel.cancelCalls).toEqual(['late-consumer']);
    expect(target.state).toBe('stopped');
  });

  it('shares repeated stops and cancels a running consumer exactly once', async () => {
    const channel = new FakeChannel();
    const cancellation = deferred<Replies.Empty>();
    const target = createSagaRabbitWorker(options(channel, noRoutes));
    await target.start();
    channel.cancelResult = cancellation.promise;

    const first = target.stop();
    const second = target.stop();
    expect(first).toBe(second);
    expect(channel.cancelCalls).toEqual(['consumer-1']);
    cancellation.resolve({});
    await Promise.all([first, second]);
  });

  it('clears matching broker cancellation and can restart', async () => {
    const channel = new FakeChannel();
    const target = createSagaRabbitWorker(options(channel, noRoutes));
    await target.start();

    channel.callbacks[0]?.(null);
    expect(target.state).toBe('stopped');
    await expect(target.start()).resolves.toBe('consumer-2');
    expect(channel.consumeCalls).toHaveLength(2);
  });

  it('does not let a cancelled startup clear a subsequent start promise', async () => {
    const channel = new FakeChannel();
    const firstConsume = deferred<Replies.Consume>();
    channel.consumeResult = firstConsume.promise;
    const target = createSagaRabbitWorker(options(channel, noRoutes));
    const first = target.start();
    await flush();
    channel.callbacks[0]?.(null);
    channel.consumeResult = null;

    const restarted = target.start();
    firstConsume.resolve({ consumerTag: 'broker-cancelled' });
    await expect(first).rejects.toThrow('interrupted');
    await expect(restarted).resolves.toBe('consumer-2');
    expect(channel.cancelCalls).toHaveLength(0);
  });

  it('ignores stale cancellation and requeues stale-generation delivery', async () => {
    const channel = new FakeChannel();
    const seen: string[] = [];
    const target = createSagaRabbitWorker(options(channel, async (event) => {
      seen.push(event.eventId);
      return [];
    }));
    await target.start();
    const stale = channel.callbacks[0];
    stale?.(null);
    await target.start();

    stale?.(null);
    stale?.(message());
    expect(target.state).toBe('running');
    expect(seen).toEqual([]);
    expect(channel.nacks).toEqual([{ message: expect.any(Object), allUpTo: false, requeue: true }]);
  });

  it('drains accepted deliveries before stop completes', async () => {
    const channel = new FakeChannel();
    const processing = deferred<void>();
    const target = createSagaRabbitWorker(options(channel, async () => {
      await processing.promise;
      return [];
    }));
    await target.start();
    channel.callbacks[0]?.(message({ body: { ...messageBody(), events: [messageBody().events[0]] } }));
    await flush();

    let stopped = false;
    const stopping = target.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    processing.resolve();
    await stopping;
    expect(channel.acks).toHaveLength(1);
  });

  it('bounds shutdown drain time while keeping late delivery completion observed', async () => {
    const channel = new FakeChannel();
    const processing = deferred<void>();
    const target = createSagaRabbitWorker(options(channel, async () => {
      await processing.promise;
      return [];
    }, [], { limits: { ...limits, shutdownTimeoutMs: 20 } }));
    await target.start();
    channel.callbacks[0]?.(message({ body: messageBody() }));
    await flush();

    await expect(target.stop()).rejects.toThrow('timed out draining');
    expect(target.state).toBe('stopped');
    processing.resolve();
    await flush();
    expect(channel.acks).toHaveLength(1);
  });
});

function messageBody() {
  return {
    id: 'commit-1',
    partitionId: 'orders',
    streamId: 'order-1',
    commitSequence: 4,
    createDateTime: '2026-09-21T10:00:00.000Z',
    events: [{ id: 'event-1', type: 'order.created.event', version: 9, payload: {} }]
  };
}
