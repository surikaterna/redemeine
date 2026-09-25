import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { normalizeSagaCorrelation, registerSagaTurnDefinition, type SagaTurnAppendRequest } from '@redemeine/saga-runtime';
import type { Channel, GetMessage } from 'amqplib';
import type { SagaRabbitChannel } from '../src';
import { createCounters, createRealTable } from './fixtures';
import {
  appendSourceCommit, connectRealStack, createScenario, instanceId, pollUntil, publishCommit, queueCounts,
  type RealStack, sourceEvent, streamCommits, waitForDeadLetter, waitForQueueSettled, wrapRepository
} from './harness';

jest.setTimeout(45_000);

interface Settlement {
  readonly kind: 'ack' | 'nack';
  readonly requeue?: boolean;
}

function observeSettlement(base: Channel, outcomes: Settlement[]): SagaRabbitChannel {
  return {
    ack: (message, allUpTo) => { base.ack(message, allUpTo); outcomes.push({ kind: 'ack' }); },
    nack: (message, allUpTo, requeue) => { base.nack(message, allUpTo, requeue); outcomes.push({ kind: 'nack', requeue: requeue ?? true }); },
    assertExchange: base.assertExchange.bind(base),
    assertQueue: base.assertQueue.bind(base),
    cancel: base.cancel.bind(base),
    consume: base.consume.bind(base),
    prefetch: base.prefetch.bind(base)
  };
}

async function inspectDeadLetter(channel: Channel, queue: string): Promise<GetMessage> {
  const found: { message: GetMessage | false } = { message: false };
  await pollUntil(`dead letter in ${queue}`, async () => {
    found.message = await channel.get(queue, { noAck: false });
    return found.message !== false;
  });
  const message = found.message;
  if (!message) throw new Error('Missing dead-letter delivery');
  const deaths: unknown = message.properties.headers?.['x-death'];
  expect(deaths).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'rejected', queue: queue.slice(0, -5), count: 1 })]));
  channel.ack(message);
  return message;
}

describe('redemeine-371j.1 real identity and non-ACK qualification', () => {
  let stack: RealStack;
  beforeAll(async () => { stack = await connectRealStack(); });
  afterAll(async () => {
    await stack.close();
    expect(stack.dispatcherFailures).toEqual([]);
  });

  it('commits one four-event start, then dead-letters duplicate and legacy replay without new writes', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('identity-guard', counters);
    const registration = registerSagaTurnDefinition({ definition, pluginManifests: [],
      responseHandlerBindings: {}, canonicalCommandTypes: [] });
    const settlements: Settlement[] = [];
    const captured: SagaTurnAppendRequest[] = [];
    const harness = await createScenario(stack, 'identity-guard', table, {
      channel: (base) => observeSettlement(base, settlements),
      repository: (base) => wrapRepository(base, async (request) => {
        if (captured.length === 0) captured.push(request);
        return base.append(request);
      }),
      prefetch: 1
    });
    try {
      const orderId = 'order-identity-guard';
      const id = instanceId(definition.sagaKey, orderId);
      const source = await appendSourceCommit(stack, { id: 'identity-guard-source', streamId: 'identity-guard-input',
        events: [sourceEvent('identity-guard-event', 'real.order-placed.v1.event', { orderId })] });
      await pollUntil('initial ACK', () => settlements.length === 1);
      await waitForQueueSettled(harness.queue);
      const physical = await streamCommits(harness, id);
      expect(physical).toHaveLength(1);
      expect(physical[0]).toMatchObject({ commitSequence: 0,
        events: [{ version: 0 }, { version: 1 }, { version: 2 }, { version: 3 }] });
      expect(physical[0]?.events.map(({ type }) => type)).toEqual([
        'saga.instance_created.event', 'saga.definition_identity_recorded.event',
        'saga.source_event_observed.event', 'saga.business_state_recorded.event'
      ]);
      expect(physical[0]?.events[1]?.payload).toEqual({ schemaVersion: 1, ...registration.definitionIdentity });
      expect(settlements).toEqual([{ kind: 'ack' }]);
      expect(counters).toMatchObject({ initial: 1, start: 0, handlers: new Map() });
      expect(captured).toHaveLength(1);

      await publishCommit(stack, source);
      await waitForDeadLetter(harness);
      await waitForQueueSettled(harness.queue);
      expect(settlements).toEqual([{ kind: 'ack' }, { kind: 'nack', requeue: false }]);
      expect((await inspectDeadLetter(harness.channel, harness.deadQueue)).properties.messageId).toBe(source.id);
      expect(await streamCommits(harness, id)).toHaveLength(1);
      expect(counters).toMatchObject({ initial: 1, start: 0, handlers: new Map() });

      const legacyId = instanceId(definition.sagaKey, 'order-legacy-identity');
      const first = captured[0];
      if (!first) throw new Error('Missing captured first turn');
      const legacyEvents = first.events.filter(({ type }) => type !== 'saga.definition_identity_recorded.event').map((event) => {
        if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) throw new Error('Invalid captured event');
        if (event.type === 'saga.instance_created.event') return { ...event, payload: { ...event.payload, id: legacyId } };
        if (event.type === 'saga.business_state_recorded.event') {
          return { ...event, payload: { ...event.payload, correlation: normalizeSagaCorrelation('order-legacy-identity') } };
        }
        return event;
      });
      expect(legacyEvents).toHaveLength(3);
      expect(await harness.repository.append({ ...first, streamId: legacyId, commitId: 'identity-legacy-seed',
        expectedNextCommitSequence: 0, identity: { ...first.identity, instanceId: legacyId }, events: legacyEvents }))
        .toMatchObject({ status: 'committed' });
      const legacyBefore = await streamCommits(harness, legacyId);
      expect(legacyBefore).toHaveLength(1);
      await appendSourceCommit(stack, { id: 'identity-legacy-delivery', streamId: 'identity-legacy-input',
        events: [sourceEvent('identity-legacy-event', 'real.order-placed.v1.event', { orderId: 'order-legacy-identity' })] });
      await waitForDeadLetter(harness);
      await waitForQueueSettled(harness.queue);
      expect(settlements).toEqual([{ kind: 'ack' }, { kind: 'nack', requeue: false }, { kind: 'nack', requeue: false }]);
      expect((await inspectDeadLetter(harness.channel, harness.deadQueue)).properties.messageId).toBe('identity-legacy-delivery');
      expect(await streamCommits(harness, legacyId)).toEqual(legacyBefore);
      expect(await queueCounts(harness.deadQueue)).toEqual({ ready: 0, unacknowledged: 0 });
      expect(counters).toMatchObject({ initial: 1, start: 0, handlers: new Map() });
      expect(harness.settlementErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
