import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { deriveSourceTriggerId, type SagaTurnAppendRequest, type SagaTurnAppendResult, type SagaTurnRepository } from '@redemeine/saga-runtime';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { ICommit } from 'tapeworm';
import type { SagaRabbitChannel } from '../src';
import type { ReplacementObservation } from './replacementObservation';
import { createCounters, createFanoutTable, createRealDefinition, createRealTable } from './fixtures';
import {
  appendSourceCommit,
  connectRealStack,
  createScenario,
  instanceId,
  pollUntil,
  publishCommit,
  queueCounts,
  type RealStack,
  replayState,
  type ScenarioHarness,
  sourceEvent,
  startReplacementWorker,
  streamCommits,
  waitForDeadLetter,
  waitForQueueSettled,
  withDeadline,
  wrapRepository
} from './harness';

jest.setTimeout(30_000);

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function commit(stack: RealStack, id: string, streamId: string, events: ReturnType<typeof sourceEvent>[]): ICommit {
  return {
    id,
    partitionId: stack.sourcePartitionId,
    streamId,
    commitSequence: 0,
    createDateTime: new Date().toISOString(),
    events: events.map((event, version) => ({ ...event, version }))
  };
}

async function waitForCommitCount(harness: ScenarioHarness, id: string, count: number): Promise<readonly ICommit[]> {
  let commits: readonly ICommit[] = [];
  await pollUntil(`${id} commit count ${count}`, async () => {
    commits = await streamCommits(harness, id);
    return commits.length === count;
  });
  return commits;
}

async function initialize(stack: RealStack, harness: ScenarioHarness, sagaKey: string, label: string, orderId = `order-${label}`): Promise<string> {
  const id = instanceId(sagaKey, orderId);
  await appendSourceCommit(stack, {
    id: `${label}-start`,
    streamId: `${label}-source`,
    events: [sourceEvent(`${label}-placed`, 'real.order-placed.v1.event', { orderId })]
  });
  await waitForCommitCount(harness, id, 1);
  await waitForQueueSettled(harness.queue);
  return id;
}

function barrierRepository(
  base: SagaTurnRepository,
  statuses: SagaTurnAppendResult['status'][]
): {
  readonly repository: SagaTurnRepository;
  readonly failures: unknown[];
  arm(): void;
} {
  const gate = deferred();
  const failures: unknown[] = [];
  let armed = false;
  let arrivals = 0;
  const append = async (request: SagaTurnAppendRequest) => {
    if (armed && arrivals < 2) {
      arrivals += 1;
      if (arrivals === 2) gate.resolve();
      await gate.promise;
    }
    try {
      const result = await base.append(request);
      statuses.push(result.status);
      return result;
    } catch (error) {
      failures.push({ error: String(error), expected: request,
        actual: await base.findCommit(request.streamId, request.commitId).catch(() => null) });
      throw error;
    }
  };
  return {
    repository: wrapRepository(base, append),
    failures,
    arm: () => {
      armed = true;
    }
  };
}

async function expectNoDeadLetters(harness: ScenarioHarness): Promise<void> {
  expect(await queueCounts(harness.deadQueue)).toEqual({ ready: 0, unacknowledged: 0 });
}

async function expectFanoutCommit(harness: ScenarioHarness, id: string, sagaKey: string): Promise<void> {
  const commits = await streamCommits(harness, id);
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({ commitSequence: 0, sagaTurnIdentity: {
    sagaKey, instanceId: id, sourceTriggerId: expect.any(String), routeId: expect.any(String)
  } });
  expect(commits[0]?.events.map(({ type }) => type)).toEqual([
    'saga.instance_created.event', 'saga.definition_identity_recorded.event',
    'saga.source_event_observed.event', 'saga.business_state_recorded.event'
  ]);
  expect(commits[0]?.events[1]?.payload).toMatchObject({ sagaKey, schemaVersion: 1 });
  expect(commits[0]?.events[2]?.payload).toMatchObject({ record: {
    eventId: 'partial-fanout-event', eventType: 'real.order-placed.v1.event',
    payload: { orderId: 'order-partial-fanout' }
  } });
  expect(commits[0]?.events[2]?.payload).not.toHaveProperty('eventId');
  expect(await replayState(harness, id)).toEqual({ count: 0, seen: [] });
}

function observeAcks(base: Channel, onAck: () => void): SagaRabbitChannel {
  return {
    ack: (message, allUpTo) => {
      base.ack(message, allUpTo);
      onAck();
    },
    nack: base.nack.bind(base),
    assertExchange: base.assertExchange.bind(base),
    assertQueue: base.assertQueue.bind(base),
    cancel: base.cancel.bind(base),
    consume: base.consume.bind(base),
    prefetch: base.prefetch.bind(base)
  };
}

interface ReplacementTrace {
  readonly deliveries: Array<{ messageId: string | undefined; redelivered: boolean }>;
  readonly outcomes: Array<{ eventId: string; statuses: readonly string[] }>;
  readonly acks: Array<string | undefined>;
}

function traceReplacement(): ReplacementTrace & ReplacementObservation {
  const deliveries: ReplacementTrace['deliveries'] = [];
  const outcomes: ReplacementTrace['outcomes'] = [];
  const acks: ReplacementTrace['acks'] = [];
  return { deliveries, outcomes, acks,
    delivered: (messageId, redelivered) => deliveries.push({ messageId, redelivered }),
    processed: (eventId, statuses) => outcomes.push({ eventId, statuses }),
    acked: (messageId) => acks.push(messageId) };
}

async function expectAckCrashRecovery(harness: ScenarioHarness, id: string, committed: readonly ICommit[],
  counters: ReturnType<typeof createCounters>, trace: ReplacementTrace): Promise<void> {
  await pollUntil('replacement redelivery and ACK', () => trace.acks.includes('ack-crash-paid'));
  expect(trace.acks).toEqual(['ack-crash-paid']);
  expect(trace.deliveries).toContainEqual({ messageId: 'ack-crash-paid', redelivered: true });
  expect(trace.outcomes).toContainEqual({ eventId: 'ack-crash-event', statuses: ['reconciled'] });
  await waitForQueueSettled(harness.queue);
  const commits = await streamCommits(harness, id);
  expect(commits).toEqual(committed);
  expect(commits[1]?.events.map(({ type }) => type)).toEqual([
    'saga.source_event_observed.event', 'saga.business_state_recorded.event'
  ]);
  expect(await replayState(harness, id)).toEqual({ count: 1, seen: ['ack-crash-event'] });
  expect(counters.handlers.get('ack-crash-event')).toBe(2);
  await expectNoDeadLetters(harness);
}

async function createAckCrashScenario(stack: RealStack, table: ReturnType<typeof createRealTable>['table'],
  channelError: Error, closed: Deferred, armed: { value: boolean }): Promise<ScenarioHarness> {
  return createScenario(stack, 'ack-crash', table, {
    channel: (base) => ({
      ack: (message: ConsumeMessage, allUpTo?: boolean) => {
        if (armed.value) throw channelError;
        base.ack(message, allUpTo);
      },
      nack: base.nack.bind(base),
      assertExchange: base.assertExchange.bind(base),
      assertQueue: base.assertQueue.bind(base),
      cancel: base.cancel.bind(base),
      consume: base.consume.bind(base),
      prefetch: base.prefetch.bind(base)
    }),
    onSettlementError: async (_failure, base) => {
      await base.close();
      closed.resolve();
    }
  });
}

describe('redemeine-wrdf real MongoDB and RabbitMQ qualification', () => {
  let stack: RealStack;

  beforeAll(async () => {
    stack = await connectRealStack();
  });

  afterAll(async () => {
    await stack.close();
    expect(stack.dispatcherFailures).toEqual([]);
  });

  it('1. durably initializes before ACK with exact event and index ordering', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('durable-init', counters, true);
    const entered = deferred();
    const release = deferred();
    const harness = await createScenario(stack, 'durable-init', table, {
      repository: (base) =>
        wrapRepository(base, async (request) => {
          entered.resolve();
          await release.promise;
          return base.append(request);
        }),
      prefetch: 1
    });
    try {
      const orderId = 'order-durable-init';
      const id = instanceId(definition.sagaKey, orderId);
      await appendSourceCommit(stack, {
        id: 'durable-init-start',
        streamId: 'durable-init-source',
        events: [sourceEvent('durable-init-placed', 'real.order-placed.v1.event', { orderId })]
      });
      await entered.promise;
      await pollUntil('delivery remains unacknowledged', async () => (await queueCounts(harness.queue)).unacknowledged === 1);
      expect(await streamCommits(harness, id)).toEqual([]);
      release.resolve();
      const commits = await waitForCommitCount(harness, id, 1);
      await waitForQueueSettled(harness.queue);
      expect(commits[0]?.events.map(({ type }) => type)).toEqual([
        'saga.instance_created.event',
        'saga.definition_identity_recorded.event',
        'saga.source_event_observed.event',
        'saga.business_state_recorded.event'
      ]);
      expect(commits[0]).toMatchObject({ commitSequence: 0, events: [{ version: 0 }, { version: 1 }, { version: 2 }, { version: 3 }] });
      expect(await replayState(harness, id)).toEqual({ count: orderId.length, seen: [] });
      expect(counters).toMatchObject({ initial: 1, start: 1, handlers: new Map() });
      const indexes = await stack.db.collection(`tw_${harness.partitionId}_commits`).listIndexes().toArray();
      expect(indexes.some(({ key, unique }) => unique === true && key.id === 1)).toBe(true);
      expect(indexes.some(({ key, unique }) => unique === true && key.streamId === 1 && key.commitSequence === 1)).toBe(true);
      await expectNoDeadLetters(harness);
    } finally {
      release.resolve();
      await harness.close();
    }
  });

  it('2. applies a subsequent event as one ordered durable turn', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('subsequent', counters);
    const harness = await createScenario(stack, 'subsequent', table);
    try {
      const id = await initialize(stack, harness, definition.sagaKey, 'subsequent');
      await appendSourceCommit(stack, {
        id: 'subsequent-paid-commit',
        streamId: 'subsequent-source',
        events: [sourceEvent('subsequent-paid', 'real.order-paid.v1.event', { orderId: 'order-subsequent', amount: 3 })]
      });
      const commits = await waitForCommitCount(harness, id, 2);
      await waitForQueueSettled(harness.queue);
      expect(commits[1]?.events.map(({ type }) => type)).toEqual(['saga.source_event_observed.event', 'saga.business_state_recorded.event']);
      expect(commits[1]).toMatchObject({ commitSequence: 1, events: [{ version: 4 }, { version: 5 }] });
      expect(await replayState(harness, id)).toEqual({ count: 3, seen: ['subsequent-paid'] });
      expect(counters.handlers.get('subsequent-paid')).toBe(1);
      await expectNoDeadLetters(harness);
    } finally {
      await harness.close();
    }
  });

  it('3. processes all events in one source commit in source order', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('multi-event', counters);
    const harness = await createScenario(stack, 'multi-event', table);
    try {
      const id = await initialize(stack, harness, definition.sagaKey, 'multi-event');
      await appendSourceCommit(stack, {
        id: 'multi-event-update',
        streamId: 'multi-event-source',
        events: [
          sourceEvent('multi-event-paid', 'real.order-paid.v1.event', { orderId: 'order-multi-event', amount: 2 }),
          sourceEvent('multi-event-adjusted', 'real.order-adjusted.v1.event', { orderId: 'order-multi-event', amount: 4 })
        ]
      });
      const commits = await waitForCommitCount(harness, id, 3);
      await waitForQueueSettled(harness.queue);
      expect(commits.map(({ commitSequence }) => commitSequence)).toEqual([0, 1, 2]);
      expect(await replayState(harness, id)).toEqual({ count: 6, seen: ['multi-event-paid', 'multi-event-adjusted'] });
      await expectNoDeadLetters(harness);
    } finally {
      await harness.close();
    }
  });

  it('4. reconciles a sequentially redelivered source commit after recomputing equivalent content', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('sequential-duplicate', counters);
    let acks = 0;
    const harness = await createScenario(stack, 'sequential-duplicate', table, {
      channel: (base) =>
        observeAcks(base, () => {
          acks += 1;
        })
    });
    try {
      const id = await initialize(stack, harness, definition.sagaKey, 'sequential-duplicate');
      const update = await appendSourceCommit(stack, {
        id: 'sequential-duplicate-paid',
        streamId: 'sequential-duplicate-source',
        events: [sourceEvent('sequential-duplicate-event', 'real.order-paid.v1.event', { orderId: 'order-sequential-duplicate' })]
      });
      await waitForCommitCount(harness, id, 2);
      await publishCommit(stack, update);
      await pollUntil('sequential duplicate ACK', () => acks === 3);
      await waitForQueueSettled(harness.queue);
      expect(await streamCommits(harness, id)).toHaveLength(2);
      expect(counters.handlers.get('sequential-duplicate-event')).toBe(2);
      await expectNoDeadLetters(harness);
    } finally {
      await harness.close();
    }
  });

  it('5. commits one concurrent duplicate and reconciles the other', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('concurrent-duplicate', counters);
    const statuses: SagaTurnAppendResult['status'][] = [];
    let control: ReturnType<typeof barrierRepository>;
    const harness = await createScenario(stack, 'concurrent-duplicate', table, {
      repository: (base) => {
        control = barrierRepository(base, statuses);
        return control.repository;
      }
    });
    try {
      const id = await initialize(stack, harness, definition.sagaKey, 'concurrent-duplicate');
      statuses.length = 0;
      control!.arm();
      const update = commit(stack, 'concurrent-duplicate-paid', 'concurrent-duplicate-manual', [
        sourceEvent('concurrent-duplicate-event', 'real.order-paid.v1.event', { orderId: 'order-concurrent-duplicate' })
      ]);
      await Promise.all([publishCommit(stack, update), publishCommit(stack, update)]);
      await waitForCommitCount(harness, id, 2);
      await pollUntil('both concurrent append outcomes', () => statuses.length === 2 || control!.failures.length > 0);
      await waitForQueueSettled(harness.queue);
      expect({ statuses: statuses.sort(), dead: await queueCounts(harness.deadQueue), failures: control!.failures,
        settlementErrors: harness.settlementErrors })
        .toMatchObject({ statuses: ['committed', 'reconciled'], dead: { ready: 0, unacknowledged: 0 }, failures: [], settlementErrors: [] });
      expect(await streamCommits(harness, id)).toHaveLength(2);
      await expectNoDeadLetters(harness);
    } finally {
      await harness.close();
    }
  });

  it('6. retries one concurrent distinct turn after a real OCC conflict', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('concurrent-distinct', counters);
    const statuses: SagaTurnAppendResult['status'][] = [];
    let control: ReturnType<typeof barrierRepository>;
    const harness = await createScenario(stack, 'concurrent-distinct', table, {
      repository: (base) => {
        control = barrierRepository(base, statuses);
        return control.repository;
      }
    });
    try {
      const id = await initialize(stack, harness, definition.sagaKey, 'concurrent-distinct');
      statuses.length = 0;
      control!.arm();
      const paid = commit(stack, 'concurrent-distinct-paid', 'concurrent-distinct-paid-source', [
        sourceEvent('concurrent-distinct-paid-event', 'real.order-paid.v1.event', { orderId: 'order-concurrent-distinct', amount: 2 })
      ]);
      const adjusted = commit(stack, 'concurrent-distinct-adjusted', 'concurrent-distinct-adjusted-source', [
        sourceEvent('concurrent-distinct-adjusted-event', 'real.order-adjusted.v1.event', { orderId: 'order-concurrent-distinct', amount: 4 })
      ]);
      await Promise.all([publishCommit(stack, paid), publishCommit(stack, adjusted)]);
      const commits = await waitForCommitCount(harness, id, 3);
      await waitForQueueSettled(harness.queue);
      expect(statuses.filter((status) => status === 'conflict')).toHaveLength(1);
      expect(commits.map(({ commitSequence }) => commitSequence)).toEqual([0, 1, 2]);
      const state = await replayState(harness, id);
      expect(state.count).toBe(6);
      expect(new Set(state.seen)).toEqual(new Set(['concurrent-distinct-paid-event', 'concurrent-distinct-adjusted-event']));
      await expectNoDeadLetters(harness);
    } finally {
      await harness.close();
    }
  });

  it('7. dead-letters unsupported intent output without a durable append', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('unsupported-intent', counters);
    const harness = await createScenario(stack, 'unsupported-intent', table);
    try {
      const id = await initialize(stack, harness, definition.sagaKey, 'unsupported-intent');
      await appendSourceCommit(stack, {
        id: 'unsupported-intent-update',
        streamId: 'unsupported-intent-source',
        events: [sourceEvent('unsupported-intent-event', 'real.order-paid.v1.event', { orderId: 'order-unsupported-intent', mode: 'intent' })]
      });
      await waitForDeadLetter(harness);
      await waitForQueueSettled(harness.queue);
      expect(await streamCommits(harness, id)).toHaveLength(1);
      expect(counters.handlers.get('unsupported-intent-event')).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('8. dead-letters oversized business state without a durable append', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('oversized-state', counters);
    const harness = await createScenario(stack, 'oversized-state', table);
    try {
      const id = await initialize(stack, harness, definition.sagaKey, 'oversized-state');
      await appendSourceCommit(stack, {
        id: 'oversized-state-update',
        streamId: 'oversized-state-source',
        events: [sourceEvent('oversized-state-event', 'real.order-adjusted.v1.event', { orderId: 'order-oversized-state', mode: 'large' })]
      });
      await waitForDeadLetter(harness);
      await waitForQueueSettled(harness.queue);
      expect(await streamCommits(harness, id)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('9. ACKs a valid source commit with no matching saga route', async () => {
    const counters = createCounters();
    const { table } = createRealTable('no-match', counters);
    let acks = 0;
    const harness = await createScenario(stack, 'no-match', table, {
      channel: (base) =>
        observeAcks(base, () => {
          acks += 1;
        })
    });
    try {
      await appendSourceCommit(stack, {
        id: 'no-match-commit',
        streamId: 'no-match-source',
        events: [sourceEvent('no-match-event', 'real.order-unknown.v1.event', { orderId: 'order-no-match' })]
      });
      await pollUntil('no-match ACK', () => acks === 1);
      await waitForQueueSettled(harness.queue);
      expect(await harness.partition.queryAll()).toEqual([]);
      expect(counters).toMatchObject({ initial: 0, start: 0, handlers: new Map() });
      await expectNoDeadLetters(harness);
    } finally {
      await harness.close();
    }
  });

  it('10. dead-letters a malformed Rabbit envelope before saga processing', async () => {
    const counters = createCounters();
    const { table } = createRealTable('malformed-envelope', counters);
    const harness = await createScenario(stack, 'malformed-envelope', table);
    try {
      const malformed = commit(stack, 'malformed-envelope-commit', 'malformed-envelope-source', [
        sourceEvent('malformed-envelope-event', 'real.order-placed.v1.event', { orderId: 'order-malformed-envelope' })
      ]);
      await publishCommit(stack, malformed, { messageId: 'wrong-message-id' });
      await waitForDeadLetter(harness);
      await waitForQueueSettled(harness.queue);
      expect(await harness.partition.queryAll()).toEqual([]);
      expect(counters.initial).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('11. requeues a transient repository failure and commits on redelivery', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('transient-retry', counters);
    let attempts = 0;
    const harness = await createScenario(stack, 'transient-retry', table, {
      repository: (base) =>
        wrapRepository(base, async (request) => {
          attempts += 1;
          if (attempts === 1) throw new Error('injected transient repository failure');
          return base.append(request);
        })
    });
    try {
      const id = instanceId(definition.sagaKey, 'order-transient-retry');
      await appendSourceCommit(stack, {
        id: 'transient-retry-start',
        streamId: 'transient-retry-source',
        events: [sourceEvent('transient-retry-event', 'real.order-placed.v1.event', { orderId: 'order-transient-retry' })]
      });
      await waitForCommitCount(harness, id, 1);
      await waitForQueueSettled(harness.queue);
      expect(attempts).toBe(2);
      expect(counters.initial).toBe(2);
      await expectNoDeadLetters(harness);
    } finally {
      await harness.close();
    }
  });

  it('12. preserves completed fanout work when a later saga fails and the delivery retries', async () => {
    const firstCounters = createCounters();
    const secondCounters = createCounters();
    const first = createRealDefinition('fanout-first', firstCounters);
    const second = createRealDefinition('fanout-second', secondCounters);
    const table = createFanoutTable(first, second);
    let failed = false;
    const harness = await createScenario(stack, 'partial-fanout', table, {
      repository: (base) =>
        wrapRepository(base, async (request) => {
          if (!failed && request.identity.sagaKey === second.sagaKey) {
            failed = true;
            throw new Error('injected second fanout failure');
          }
          return base.append(request);
        })
    });
    try {
      await appendSourceCommit(stack, {
        id: 'partial-fanout-start',
        streamId: 'partial-fanout-source',
        events: [sourceEvent('partial-fanout-event', 'real.order-placed.v1.event', { orderId: 'order-partial-fanout' })]
      });
      const firstId = instanceId(first.sagaKey, 'order-partial-fanout');
      const secondId = instanceId(second.sagaKey, 'order-partial-fanout');
      await Promise.all([waitForCommitCount(harness, firstId, 1), waitForCommitCount(harness, secondId, 1)]);
      await waitForQueueSettled(harness.queue);
      expect(firstCounters.initial).toBe(2);
      expect(secondCounters.initial).toBe(2);
      expect(failed).toBe(true);
      await expectFanoutCommit(harness, firstId, first.sagaKey);
      await expectFanoutCommit(harness, secondId, second.sagaKey);
      const [firstCommit] = await streamCommits(harness, firstId);
      const [secondCommit] = await streamCommits(harness, secondId);
      const firstSource = firstCommit?.sagaTurnIdentity as { sourceTriggerId: string } | undefined;
      const secondSource = secondCommit?.sagaTurnIdentity as { sourceTriggerId: string } | undefined;
      const sourceTriggerId = deriveSourceTriggerId({ partitionId: stack.sourcePartitionId,
        streamId: 'partial-fanout-source', commitId: 'partial-fanout-start', eventIndex: 0 });
      expect(firstSource?.sourceTriggerId).toBe(sourceTriggerId);
      expect(secondSource?.sourceTriggerId).toBe(sourceTriggerId);
      await expectNoDeadLetters(harness);
    } finally {
      await harness.close();
    }
  });

  it('13. reports an ACK channel failure and safely reconciles after worker restart', async () => {
    const counters = createCounters();
    const { definition, table } = createRealTable('ack-crash', counters);
    const channelError = new Error('injected ACK channel failure');
    const closed = deferred();
    const armed = { value: false };
    const trace = traceReplacement();
    const harness = await createAckCrashScenario(stack, table, channelError, closed, armed);
    let replacement: Awaited<ReturnType<typeof startReplacementWorker>> | undefined;
    try {
      const id = await initialize(stack, harness, definition.sagaKey, 'ack-crash');
      armed.value = true;
      const update = commit(stack, 'ack-crash-paid', 'ack-crash-manual', [
        sourceEvent('ack-crash-event', 'real.order-paid.v1.event', { orderId: 'order-ack-crash' })
      ]);
      await publishCommit(stack, update);
      const committed = await waitForCommitCount(harness, id, 2);
      await pollUntil('settlement observer', () => harness.settlementErrors.length === 1);
      expect(harness.settlementErrors[0]).toMatchObject({ error: channelError, settlement: 'ack' });
      const failedDelivery = harness.settlementErrors[0]!.message;
      expect(failedDelivery.properties.messageId).toBe('ack-crash-paid');
      expect(JSON.parse(failedDelivery.content.toString()).events[0].id).toBe('ack-crash-event');
      await withDeadline('original channel close', closed.promise);
      replacement = await startReplacementWorker(stack, harness, table, trace);
      await expectAckCrashRecovery(harness, id, committed, counters, trace);
    } finally {
      if (replacement) await replacement.close();
      await harness.close();
    }
  });
});
