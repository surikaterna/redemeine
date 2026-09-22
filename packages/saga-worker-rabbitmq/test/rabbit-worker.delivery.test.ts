import { describe, expect, it } from '@jest/globals';
import { SagaTurnTransientError, SagaTurnUnsupportedError } from '@redemeine/saga-runtime';
import { createSagaRabbitWorker, decodeSagaRabbitMessage } from '../src/index';
import { body, deferred, FakeChannel, flush, limits, message, options, source } from './helpers';

const noRoutes = async () => [] as const;

describe('Rabbit saga worker delivery', () => {
  it('accepts stream-global versions 9 and 10 and preserves event order', async () => {
    const channel = new FakeChannel();
    const seen: Array<{ id: string; version: number }> = [];
    const target = createSagaRabbitWorker(options(channel, async (event) => {
      seen.push({ id: event.eventId, version: event.sequence });
      expect(channel.acks).toHaveLength(0);
      return [];
    }));

    await target.handle(message());
    expect(seen).toEqual([{ id: 'event-1', version: 9 }, { id: 'event-2', version: 10 }]);
    expect(channel.acks).toHaveLength(1);
    expect(channel.nacks).toHaveLength(0);
  });

  it('does not settle while processor work remains unresolved', async () => {
    const channel = new FakeChannel();
    const processing = deferred<void>();
    const target = createSagaRabbitWorker(options(channel, async () => {
      await processing.promise;
      return [];
    }));
    const input = message({ body: { ...body(), events: [body().events[0]] } });

    const handling = target.handle(input);
    await flush();
    expect(channel.acks).toHaveLength(0);
    expect(channel.nacks).toHaveLength(0);
    processing.resolve();
    await handling;
    expect(channel.acks).toEqual([{ message: input, allUpTo: false }]);
  });

  it.each([
    [new SagaTurnTransientError('temporary', 'temporary'), true],
    [new SagaTurnUnsupportedError('unsupported_intents', 'unsupported'), false]
  ] as const)('maps processing failures to one NACK disposition', async (error, requeue) => {
    const channel = new FakeChannel();
    const target = createSagaRabbitWorker(options(channel, async () => {
      throw error;
    }));

    await target.handle(message());
    expect(channel.nacks).toEqual([{ message: expect.any(Object), allUpTo: false, requeue }]);
    expect(channel.acks).toHaveLength(0);
  });

  it('defaults unknown processor failures to a single requeue NACK', async () => {
    const channel = new FakeChannel();
    const target = createSagaRabbitWorker(options(channel, async () => {
      throw new Error('unknown');
    }));
    await target.handle(message());
    expect(channel.nacks).toEqual([{ message: expect.any(Object), allUpTo: false, requeue: true }]);
    expect(channel.acks).toHaveLength(0);
  });

  it('stops at the failed event and settles a partial commit once', async () => {
    const channel = new FakeChannel();
    const seen: string[] = [];
    const target = createSagaRabbitWorker(options(channel, async (event) => {
      seen.push(event.eventId);
      if (event.eventId === 'event-2') throw new SagaTurnTransientError('temporary', 'temporary');
      return [];
    }));
    await target.handle(message());
    expect(seen).toEqual(['event-1', 'event-2']);
    expect(channel.nacks).toEqual([{ message: expect.any(Object), allUpTo: false, requeue: true }]);
    expect(channel.acks).toHaveLength(0);
  });

  it('attempts only ACK and reports a closed-channel ACK exception', async () => {
    const channel = new FakeChannel();
    const failures: unknown[] = [];
    channel.ackError = new Error('channel closed');
    const target = createSagaRabbitWorker(options(channel, noRoutes, failures));

    await expect(target.handle(message())).rejects.toThrow('channel closed');
    expect(channel.acks).toHaveLength(1);
    expect(channel.nacks).toHaveLength(0);
    expect(failures).toEqual([expect.objectContaining({ settlement: 'ack', error: channel.ackError })]);
  });

  it('attempts only NACK and reports a closed-channel NACK exception', async () => {
    const channel = new FakeChannel();
    const failures: unknown[] = [];
    channel.nackError = new Error('channel closed');
    const target = createSagaRabbitWorker(options(channel, async () => {
      throw new SagaTurnTransientError('temporary', 'temporary');
    }, failures));

    await expect(target.handle(message())).rejects.toThrow('channel closed');
    expect(channel.nacks).toHaveLength(1);
    expect(channel.acks).toHaveLength(0);
    expect(failures).toEqual([expect.objectContaining({ settlement: 'nack', requeue: true })]);
  });

  it('observes tracked settlement exceptions without rejecting stop', async () => {
    const channel = new FakeChannel();
    const failures: unknown[] = [];
    channel.ackError = new Error('channel closed');
    const target = createSagaRabbitWorker(options(channel, noRoutes, failures));
    await target.start();

    channel.callbacks[0]?.(message());
    await flush();
    await expect(target.stop()).resolves.toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it('rejects oversized bodies before JSON decoding', () => {
    const input = message({ content: Buffer.from('{not-json-but-over-limit}') });
    expect(() => decodeSagaRabbitMessage(input, source, { ...limits, maxBodyBytes: 4 })).toThrow('maxBodyBytes');
  });

  it('rejects commits above the event-count bound', async () => {
    const channel = new FakeChannel();
    const target = createSagaRabbitWorker(options(channel, noRoutes, [], { limits: { ...limits, maxEvents: 1 } }));
    await target.handle(message());
    expect(channel.nacks[0]).toMatchObject({ requeue: false });
  });

  it('bounds tracked work to prefetch and requeues excess callbacks', async () => {
    const channel = new FakeChannel();
    const processing = deferred<void>();
    let processed = 0;
    const target = createSagaRabbitWorker(options(channel, async () => {
      processed += 1;
      await processing.promise;
      return [];
    }, [], { limits: { ...limits, prefetch: 1 } }));
    await target.start();
    const oneEvent = message({ body: { ...body(), events: [body().events[0]] } });

    channel.callbacks[0]?.(oneEvent);
    channel.callbacks[0]?.(message({ body: { ...body(), events: [body().events[0]] } }));
    await flush();
    expect(processed).toBe(1);
    expect(channel.nacks).toEqual([{ message: expect.any(Object), allUpTo: false, requeue: true }]);
    processing.resolve();
    await target.stop();
  });

  it.each([
    ['invalid JSON', message({ body: '{bad-json' })],
    ['invalid content type', message({ contentType: 'text/plain' })],
    ['missing message id', message({ messageId: undefined })],
    ['empty message id', message({ messageId: '' })],
    ['spoofed commit id', message({ body: { ...body(), id: 'other' } })],
    ['spoofed partition body', message({ body: { ...body(), partitionId: 'other' } })],
    ['partition outside scope', message({ headers: { partitionId: 'other', streamId: 'order-1', collection: 'commits' }, body: { ...body(), partitionId: 'other' } })],
    ['spoofed stream header', message({ headers: { partitionId: 'orders', streamId: 'other', collection: 'commits' } })],
    ['wrong collection', message({ headers: { partitionId: 'orders', streamId: 'order-1', collection: 'other' } })],
    ['missing event id', message({ body: { ...body(), events: [{ ...body().events[0], id: '' }] } })],
    ['missing event type', message({ body: { ...body(), events: [{ ...body().events[0], type: '' }] } })],
    ['noninteger version', message({ body: { ...body(), events: [{ ...body().events[0], version: 9.5 }] } })],
    ['duplicate version', message({ body: { ...body(), events: [{ ...body().events[0], version: 9 }, { ...body().events[1], version: 9 }] } })],
    ['version gap', message({ body: { ...body(), events: [{ ...body().events[0], version: 9 }, { ...body().events[1], version: 11 }] } })]
  ])('rejects invalid identity, scope, or order: %s', async (_label, input) => {
    const channel = new FakeChannel();
    const target = createSagaRabbitWorker(options(channel, noRoutes));
    await target.handle(input);
    expect(channel.nacks).toEqual([{ message: input, allUpTo: false, requeue: false }]);
    expect(channel.acks).toHaveLength(0);
  });
});
