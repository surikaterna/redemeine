import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { normalizeSagaCorrelation, registerSagaTurnDefinition, type SagaTurnAppendRequest } from '@redemeine/saga-runtime';
import type { Channel, GetMessage } from 'amqplib';
import { createCounters, createRealTable } from './fixtures';
import {
  appendSourceCommit, connectRealStack, createScenario, instanceId, pollUntil, publishCommit, queueCounts,
  type RealStack, sourceEvent, streamCommits, waitForQueueSettled, wrapRepository
} from './harness';
import { deliveryIdentity, observeIdentitySettlements, type SettlementTrace, waitForIdentitySettlement } from './identitySettlements';

jest.setTimeout(45_000);

async function inspectDeadLetter(channel: Channel, queue: string, messageId: string, sourceEventId: string): Promise<GetMessage> {
  const found: { message: GetMessage | false } = { message: false };
  await pollUntil(`dead letter in ${queue}`, async () => {
    found.message = await channel.get(queue, { noAck: false });
    return found.message !== false;
  });
  const message = found.message;
  if (!message) throw new Error('Missing dead-letter delivery');
  expect(deliveryIdentity(message)).toEqual({ messageId, sourceEventId });
  const deaths: unknown = message.properties.headers?.['x-death'];
  expect(deaths).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'rejected', queue: queue.slice(0, -5), count: 1 })]));
  channel.ack(message);
  return message;
}

describe('redemeine-371j.2 real duplicate proof and legacy refusal', () => {
  let stack: RealStack;
  beforeAll(async () => { stack = await connectRealStack(); });
  afterAll(async () => {
    await stack.close();
    expect(stack.dispatcherFailures).toEqual([]);
  });

  it('ACKs only equivalent duplicate material and dead-letters legacy replay without new writes', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('identity-guard', counters);
    const registration = registerSagaTurnDefinition({ definition, pluginManifests: [],
      responseHandlerBindings: {}, canonicalCommandTypes: [] });
    const trace: SettlementTrace = { received: [], settled: [] };
    const captured: SagaTurnAppendRequest[] = [];
    const harness = await createScenario(stack, 'identity-guard', table, {
      channel: (base) => observeIdentitySettlements(base, trace),
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
      await waitForIdentitySettlement(trace, { kind: 'ack', messageId: 'identity-guard-source', sourceEventId: 'identity-guard-event' },
        1, harness.queue, harness.deadQueue);
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
      expect(trace.settled).toEqual([{ kind: 'ack', messageId: source.id, sourceEventId: 'identity-guard-event' }]);
      expect(counters).toMatchObject({ initial: 1, start: 0, handlers: new Map() });
      expect(captured).toHaveLength(1);

      await publishCommit(stack, source);
      await waitForIdentitySettlement(trace, { kind: 'ack', messageId: source.id,
        sourceEventId: 'identity-guard-event' }, 2, harness.queue, harness.deadQueue);
      await waitForQueueSettled(harness.queue);
      expect(trace.settled).toEqual([
        { kind: 'ack', messageId: source.id, sourceEventId: 'identity-guard-event' },
        { kind: 'ack', messageId: source.id, sourceEventId: 'identity-guard-event' }
      ]);
      expect(await queueCounts(harness.deadQueue)).toEqual({ ready: 0, unacknowledged: 0 });
      expect(await streamCommits(harness, id)).toHaveLength(1);
      expect(counters).toMatchObject({ initial: 2, start: 0, handlers: new Map() });

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
      await waitForIdentitySettlement(trace, { kind: 'nack', messageId: 'identity-legacy-delivery',
        sourceEventId: 'identity-legacy-event', requeue: false }, 3, harness.queue, harness.deadQueue);
      await waitForQueueSettled(harness.queue);
      expect(trace.settled).toEqual([
        { kind: 'ack', messageId: source.id, sourceEventId: 'identity-guard-event' },
        { kind: 'ack', messageId: source.id, sourceEventId: 'identity-guard-event' },
        { kind: 'nack', messageId: 'identity-legacy-delivery', sourceEventId: 'identity-legacy-event', requeue: false }
      ]);
      await inspectDeadLetter(harness.channel, harness.deadQueue, 'identity-legacy-delivery', 'identity-legacy-event');
      expect(await streamCommits(harness, legacyId)).toEqual(legacyBefore);
      await pollUntil('legacy DLQ drained', async () => {
        const counts = await queueCounts(harness.deadQueue);
        return counts.ready === 0 && counts.unacknowledged === 0;
      });
      expect(await queueCounts(harness.deadQueue)).toEqual({ ready: 0, unacknowledged: 0 });
      expect(trace.settled).toHaveLength(3);
      expect(counters).toMatchObject({ initial: 2, start: 0, handlers: new Map() });
      expect(harness.settlementErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('ACKs a historical on turn only after its original prefix and full source material match', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('historical-proof', counters);
    const trace: SettlementTrace = { received: [], settled: [] };
    const harness = await createScenario(stack, 'historical-proof', table, {
      channel: (base) => observeIdentitySettlements(base, trace), prefetch: 1
    });
    try {
      const orderId = 'order-historical-proof';
      const id = instanceId(definition.sagaKey, orderId);
      await appendSourceCommit(stack, { id: 'historical-start', streamId: 'historical-start-input',
        events: [sourceEvent('historical-placed', 'real.order-placed.v1.event', { orderId })] });
      await waitForIdentitySettlement(trace, { kind: 'ack', messageId: 'historical-start', sourceEventId: 'historical-placed' },
        1, harness.queue, harness.deadQueue);
      const first = await appendSourceCommit(stack, { id: 'historical-first', streamId: 'historical-first-input',
        events: [sourceEvent('historical-paid', 'real.order-paid.v1.event', { orderId, amount: 3 })] });
      await waitForIdentitySettlement(trace, { kind: 'ack', messageId: 'historical-first', sourceEventId: 'historical-paid' },
        2, harness.queue, harness.deadQueue);
      await appendSourceCommit(stack, { id: 'historical-second', streamId: 'historical-second-input',
        events: [sourceEvent('historical-adjusted', 'real.order-adjusted.v1.event', { orderId, amount: 2 })] });
      await waitForIdentitySettlement(trace, { kind: 'ack', messageId: 'historical-second', sourceEventId: 'historical-adjusted' },
        3, harness.queue, harness.deadQueue);
      const before = await streamCommits(harness, id);
      expect(before).toHaveLength(3);
      await publishCommit(stack, first);
      await waitForIdentitySettlement(trace, { kind: 'ack', messageId: 'historical-first', sourceEventId: 'historical-paid' },
        4, harness.queue, harness.deadQueue);
      expect(await streamCommits(harness, id)).toEqual(before);
      const changed = { ...first, events: first.events.map((event) => ({ ...event,
        payload: { orderId, amount: 99 } })) };
      await publishCommit(stack, changed);
      await waitForIdentitySettlement(trace, { kind: 'nack', messageId: 'historical-first',
        sourceEventId: 'historical-paid', requeue: false }, 5, harness.queue, harness.deadQueue);
      await inspectDeadLetter(harness.channel, harness.deadQueue, 'historical-first', 'historical-paid');
      expect(await streamCommits(harness, id)).toEqual(before);
      expect(harness.settlementErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
