import { describe, expect, it, jest } from '@jest/globals';
import type { ProjectionCommitCoordinator, ProjectionCommitCoordinatorOutcome } from '@redemeine/projection-worker-core';
import {
  ProjectionRabbitWorker,
  type ProjectionRabbitChannel,
  type RabbitDelivery,
  type RabbitSettlementEvent
} from '../src';

const commitWire = {
  id: '22222222-2222-4222-8222-222222222222',
  partitionId: 'orders',
  streamId: '11111111-1111-4111-8111-111111111111',
  commitSequence: 0,
  events: [{
    id: '33333333-3333-4333-8333-333333333333', type: 'Created', version: 0,
    aggregateType: 'Order', aggregateId: 'order-1', payload: { value: 1 }, timestamp: '2026-09-22T00:00:00.000Z'
  }]
};

function delivery(tag = 1, body: unknown = commitWire): RabbitDelivery {
  return {
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { deliveryTag: tag, redelivered: tag > 1 },
    properties: { messageId: commitWire.id }
  };
}

class FakeChannel implements ProjectionRabbitChannel {
  handler: ((message: RabbitDelivery | null) => void) | undefined;
  readonly lifecycle: string[] = [];
  readonly ack = jest.fn<(message: RabbitDelivery) => void>();
  readonly nack = jest.fn<(message: RabbitDelivery, allUpTo: false, requeue: false) => void>();
  readonly cancel = jest.fn(async () => undefined);
  readonly assertExchange = jest.fn(async () => { this.lifecycle.push('exchange'); });
  readonly assertQueue = jest.fn(async () => { this.lifecycle.push('queue'); });
  readonly prefetch = jest.fn(async () => { this.lifecycle.push('prefetch'); });
  readonly consume = jest.fn(async (_queue: string, handler: (message: RabbitDelivery | null) => void) => {
    this.lifecycle.push('consume');
    this.handler = handler;
    return { consumerTag: 'consumer-1' };
  });

  deliver(message: RabbitDelivery | null): void {
    this.handler?.(message);
  }
}

const completed: ProjectionCommitCoordinatorOutcome = { status: 'completed', processedSequences: [0], definitions: [] };
const terminal: ProjectionCommitCoordinatorOutcome = { status: 'terminal', reason: 'registry mismatch', processedSequences: [], definitions: [] };
const retryable: ProjectionCommitCoordinatorOutcome = { status: 'retryable', reason: 'bounded gap', processedSequences: [], definitions: [] };

function coordinator(outcome: ProjectionCommitCoordinatorOutcome): ProjectionCommitCoordinator {
  return { process: jest.fn(async () => outcome) };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function workerOptions(source: ProjectionCommitCoordinator, events: RabbitSettlementEvent[] = []) {
  return {
    queue: 'projection-direct', deadLetterExchange: 'projection-dlx', deadLetterRoutingKey: 'projection.failed',
    prefetch: 4, maxMessageBytes: 64_000, retryBackoffMs: 1_000, now: () => 10_000, coordinator: source,
    initialize: jest.fn(async () => undefined),
    scheduleRetry: jest.fn(async () => ({ durable: true as const, notBeforeEpochMs: 11_000 })),
    observeSettlement: jest.fn(async (event: RabbitSettlementEvent) => { events.push(event); })
  };
}

describe('ProjectionRabbitWorker', () => {
  it('asserts durable DLX/manual-ack lifecycle and ACKs exactly once after completion', async () => {
    const channel = new FakeChannel();
    const options = workerOptions(coordinator(completed));
    const worker = new ProjectionRabbitWorker(options);
    await worker.start(channel);
    expect(channel.assertExchange).toHaveBeenCalledWith('projection-dlx', 'direct', {
      durable: true, arguments: {}
    });
    expect(channel.assertQueue).toHaveBeenCalledWith('projection-direct', {
      durable: true, deadLetterExchange: 'projection-dlx', deadLetterRoutingKey: 'projection.failed'
    });
    expect(channel.prefetch).toHaveBeenCalledWith(4);
    expect(channel.consume).toHaveBeenCalledWith('projection-direct', expect.any(Function), { noAck: false });
    expect(channel.lifecycle).toEqual(['exchange', 'queue', 'prefetch', 'consume']);
    const message = delivery();
    channel.deliver(message);
    channel.deliver(message);
    await flush();
    expect(options.coordinator.process).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
    await worker.stop();
    expect(channel.cancel).toHaveBeenCalledWith('consumer-1');
  });

  it('does not settle twice when ACK throws and awaits but swallows observer failure', async () => {
    const channel = new FakeChannel();
    channel.ack.mockImplementation(() => { throw new Error('channel closed'); });
    const options = workerOptions(coordinator(completed));
    options.observeSettlement.mockRejectedValueOnce(new Error('telemetry down'));
    const worker = new ProjectionRabbitWorker(options);
    await worker.start(channel);
    const message = delivery();
    channel.deliver(message);
    channel.deliver(message);
    await flush();
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('reprocesses an ACK-uncertain delivery only after process restart', async () => {
    const source = coordinator(completed);
    const firstChannel = new FakeChannel();
    firstChannel.ack.mockImplementation(() => { throw new Error('connection lost during ACK'); });
    const firstWorker = new ProjectionRabbitWorker(workerOptions(source));
    await firstWorker.start(firstChannel);
    firstChannel.deliver(delivery(1));
    await flush();

    const restartedChannel = new FakeChannel();
    const restartedWorker = new ProjectionRabbitWorker(workerOptions(source));
    await restartedWorker.start(restartedChannel);
    restartedChannel.deliver(delivery(2));
    await flush();
    expect(source.process).toHaveBeenCalledTimes(2);
    expect(firstChannel.ack).toHaveBeenCalledTimes(1);
    expect(restartedChannel.ack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid JSON', coordinator(completed), delivery(1, '{'), 'permanent'],
    ['message identity mismatch', coordinator(completed), { ...delivery(), properties: { messageId: 'wrong' } }, 'permanent'],
    ['terminal registry/integrity failure', coordinator(terminal), delivery(), 'permanent']
  ])('dead-letters %s without requeue', async (_label, source, message, kind) => {
    const events: RabbitSettlementEvent[] = [];
    const channel = new FakeChannel();
    const worker = new ProjectionRabbitWorker(workerOptions(source, events));
    await worker.start(channel);
    channel.deliver(message);
    await flush();
    expect(channel.nack).toHaveBeenCalledWith(message, false, false);
    expect(events.at(-1)?.kind).toBe(kind);
  });

  it('durably schedules bounded-gap retry before NACK and never sleeps with delivery held', async () => {
    const events: RabbitSettlementEvent[] = [];
    const channel = new FakeChannel();
    const options = workerOptions(coordinator(retryable), events);
    const order: string[] = [];
    options.scheduleRetry.mockImplementation(async () => {
      order.push('scheduled');
      return { durable: true, notBeforeEpochMs: 11_000 };
    });
    channel.nack.mockImplementation(() => { order.push('nack'); });
    const worker = new ProjectionRabbitWorker(options);
    await worker.start(channel);
    channel.deliver(delivery());
    await flush();
    expect(order).toEqual(['scheduled', 'nack']);
    expect(events.at(-1)?.kind).toBe('retry');
  });

  it('leaves settlement uncertain instead of hot-looping when durable backoff is not proven', async () => {
    const events: RabbitSettlementEvent[] = [];
    const channel = new FakeChannel();
    const options = workerOptions(coordinator(retryable), events);
    options.scheduleRetry.mockResolvedValue({ durable: true, notBeforeEpochMs: 10_999 });
    const worker = new ProjectionRabbitWorker(options);
    await worker.start(channel);
    channel.deliver(delivery());
    await flush();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).not.toHaveBeenCalled();
    expect(events.at(-1)?.kind).toBe('settlement_uncertain');
  });

  it('dead-letters an oversized delivery before decoding or coordinator dispatch', async () => {
    const channel = new FakeChannel();
    const source = coordinator(completed);
    const options = { ...workerOptions(source), maxMessageBytes: 1 };
    const worker = new ProjectionRabbitWorker(options);
    await worker.start(channel);
    const message = delivery();
    channel.deliver(message);
    await flush();
    expect(source.process).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(message, false, false);
  });

  it('redelivers the whole P-own/N-none/Q registry after partial failure; coverage does not suppress none', async () => {
    let ownHandlerRuns = 0;
    let noneHandlerRuns = 0;
    let qHandlerRuns = 0;
    const process = jest.fn(async () => {
      const redelivery = process.mock.calls.length > 1;
      if (!redelivery) ownHandlerRuns += 1;
      noneHandlerRuns += 1;
      qHandlerRuns += 1;
      return redelivery ? completed : retryable;
    });
    const source: ProjectionCommitCoordinator = { process };
    const channel = new FakeChannel();
    const options = workerOptions(source);
    const worker = new ProjectionRabbitWorker(options);
    await worker.start(channel);
    channel.deliver(delivery(1));
    await flush();
    channel.deliver(delivery(2));
    await flush();
    expect(process).toHaveBeenCalledTimes(2);
    expect({ ownHandlerRuns, noneHandlerRuns, qHandlerRuns }).toEqual({
      ownHandlerRuns: 1, noneHandlerRuns: 2, qHandlerRuns: 2
    });
    expect(options.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('fails closed on cancellation and re-verifies readiness on reconnect', async () => {
    const cancelled = jest.fn(async () => undefined);
    const options = { ...workerOptions(coordinator(completed)), onConsumerCancelled: cancelled };
    const worker = new ProjectionRabbitWorker(options);
    const first = new FakeChannel();
    await worker.start(first);
    first.deliver(null);
    await flush();
    expect(cancelled).toHaveBeenCalledTimes(1);
    await worker.start(new FakeChannel());
    expect(options.initialize).toHaveBeenCalledTimes(2);
  });

  it('fails closed before queue assertion when the DLX is missing or mismatched', async () => {
    const channel = new FakeChannel();
    channel.assertExchange.mockRejectedValue(new Error('PRECONDITION_FAILED exchange mismatch'));
    const worker = new ProjectionRabbitWorker(workerOptions(coordinator(completed)));
    await expect(worker.start(channel)).rejects.toThrow('exchange mismatch');
    expect(channel.assertQueue).not.toHaveBeenCalled();
    expect(channel.prefetch).not.toHaveBeenCalled();
    expect(channel.consume).not.toHaveBeenCalled();
  });
});
