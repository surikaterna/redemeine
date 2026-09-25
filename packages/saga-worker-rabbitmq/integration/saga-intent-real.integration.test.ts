import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createSagaAggregate, deriveSourceTriggerId, type SagaTurnAppendRequest } from '@redemeine/saga-runtime';
import { decodeIntent } from '../../saga-runtime/src/intentWire';
import { openMongoSagaTurnRepository } from '@redemeine/saga-runtime-store-tapeworm';
import type { Event } from '@redemeine/kernel';
import type { Channel } from 'amqplib';
import type { ICommit } from 'tapeworm';
import { createFanoutIntentTable, createIntentTable, intentRegistry } from './intentFixtures';
import { assertPhysicalTurn } from './intentAssertions';
import { concurrentIntents, gatedFanout } from './intentFaults';
import { observeIdentitySettlements, type SettlementTrace, waitForIdentitySettlement } from './identitySettlements';
import { appendSourceCommit, connectRealStack, createScenario, instanceId, pollUntil, publishCommit, queueCounts,
  type RealStack, sourceEvent, streamCommits, waitForDeadLetter, waitForQueueSettled,
  startReplacementWorker, wrapRepository, type ScenarioHarness } from './harness';

jest.setTimeout(45_000);

function trace(): SettlementTrace { return { received: [], settled: [] }; }

function replacementObservations() {
  const deliveries: Array<{ id: string | undefined; redelivered: boolean }> = [];
  const outcomes: string[][] = [];
  const acks: Array<string | undefined> = [];
  return { deliveries, outcomes, acks, observer: {
    delivered: (messageId: string | undefined, redelivered: boolean) =>
      deliveries.push({ id: messageId, redelivered }),
    processed: (_eventId: string, statuses: readonly string[]) => outcomes.push([...statuses]),
    acked: (messageId: string | undefined) => acks.push(messageId)
  } };
}

function wireIntent(payload: unknown) {
  if (typeof payload !== 'object' || payload === null || !('intent' in payload)) throw new Error('missing intent');
  return decodeIntent(payload.intent, intentRegistry);
}

async function settled(harness: ScenarioHarness, observed: SettlementTrace, id: string, eventId: string,
  kind: 'ack' | 'nack', ordinal: number): Promise<void> {
  await waitForIdentitySettlement(observed, { kind, messageId: id, sourceEventId: eventId,
    ...(kind === 'nack' ? { requeue: false } : {}) }, ordinal, harness.queue, harness.deadQueue);
  await waitForQueueSettled(harness.queue);
}

function checkTurn(commit: ICommit, request: SagaTurnAppendRequest, partitionId: string,
  start: boolean, data: 'null' | 'none' | 'object'): void {
  const types = commit.events.map(event => event.type);
  expect(types).toEqual([
    ...(start ? ['saga.instance_created.event', 'saga.definition_identity_recorded.event'] : []),
    'saga.source_event_observed.event', 'saga.business_state_recorded.event',
    ...Array.from({ length: 6 }, (_, i) => i >= 4
      ? ['saga.intent_recorded.event', 'saga.timer_fact_recorded.event'] : ['saga.intent_recorded.event']).flat()
  ]);
  assertPhysicalTurn(commit, request, partitionId, start ? 0 : 12);
  const intents = commit.events.filter(event => event.type === 'saga.intent_recorded.event').map(event => wireIntent(event.payload));
  expect(intents.map(intent => intent.kind)).toEqual(['plugin', 'plugin', 'dispatch', 'dispatch', 'schedule', 'cancelSchedule']);
  expect(intents.map(intent => intent.origin.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(new Set(intents.map(intent => intent.intentId)).size).toBe(6);
  expect(intents.map(intent => intent.schemaVersion)).toEqual([1, 1, 1, 1, 1, 1]);
  expect(intents[2]).toMatchObject({ kind: 'dispatch', command: 'invoice.pay.command', payload: 'a1' });
  expect(intents[3]).toMatchObject({ kind: 'dispatch', command: 'billing.charge.command', payload: 'a1' });
  const response = intents[start ? 1 : 0];
  expect(response).toMatchObject({ plugin_key: 'outbound', action_name: 'ask', interaction: 'request_response',
    routing_metadata: { response_handler_key: 'done', error_handler_key: 'failed', retry_handler_key: 'again' } });
  if (!response || response.kind !== 'plugin' || response.interaction !== 'request_response') throw new Error('missing response');
  expect(Object.hasOwn(response.routing_metadata, 'handler_data')).toBe(data !== 'none');
  if (data === 'null') expect(response.routing_metadata.handler_data).toBeNull();
  if (data === 'object') expect(response.routing_metadata.handler_data).toEqual({ tag: 'on' });
  expect(intents[start ? 0 : 1]).toMatchObject({ plugin_key: 'outbound', action_name: 'send', interaction: 'fire_and_forget' });
  expect(intents[4]).toMatchObject({ kind: 'schedule', timerId: start ? 'start-timer' : 'on-timer', dueAt: expect.any(String) });
  expect(intents[5]).toMatchObject({ kind: 'cancelSchedule', timerId: start ? 'start-timer' : 'on-timer' });
  const scheduled = intents[4];
  if (!scheduled || scheduled.kind !== 'schedule') throw new Error('missing schedule');
  expect(commit.events.filter(event => event.type === 'saga.timer_fact_recorded.event').map(event => event.payload))
    .toEqual([{ schemaVersion: 1, fact: { action: 'schedule', intentId: intents[4]?.intentId,
      timerId: start ? 'start-timer' : 'on-timer', dueAt: scheduled.dueAt } },
    { schemaVersion: 1, fact: { action: 'cancelSchedule', intentId: intents[5]?.intentId,
      timerId: start ? 'start-timer' : 'on-timer' } }]);
}

describe('redemeine-vpwm.3.3 physical intent turns', () => {
  let stack: RealStack;
  beforeAll(async () => { stack = await connectRealStack(); });
  afterAll(async () => { await stack.close(); expect(stack.dispatcherFailures).toEqual([]); });

  it.each([undefined, null, { tag: 'on' }] as const)(
    'persists complete start/on commits with handler data %p, survives restart and compares duplicate content', async data => {
    const label = `intent-roundtrip-${data === undefined ? 'none' : data === null ? 'null' : 'object'}`;
    const { definition, table } = createIntentTable(label, 'normal', data);
    const observed = trace();
    const requests: SagaTurnAppendRequest[] = [];
    const harness = await createScenario(stack, label, table, { prefetch: 1,
      channel: base => observeIdentitySettlements(base, observed),
      repository: base => wrapRepository(base, async request => { requests.push(request); return base.append(request); }) });
    try {
      const orderId = `order-${label}`;
      const id = instanceId(definition.sagaKey, orderId);
      const first = await appendSourceCommit(stack, { id: `${label}-first`, streamId: `${label}-input`,
        events: [sourceEvent(`${label}-placed`, 'real.order-placed.v1.event', { orderId })] });
      await settled(harness, observed, first.id, `${label}-placed`, 'ack', 1);
      const second = await appendSourceCommit(stack, { id: `${label}-second`, streamId: `${label}-input`,
        events: [sourceEvent(`${label}-paid`, 'real.order-paid.v1.event', { orderId })] });
      await settled(harness, observed, second.id, `${label}-paid`, 'ack', 2);
      const physical = await streamCommits(harness, id);
      expect(physical).toHaveLength(2);
      expect(requests).toHaveLength(2);
      const shape = data === undefined ? 'none' : data === null ? 'null' : 'object';
      checkTurn(physical[0]!, requests[0]!, harness.partitionId, true, shape);
      checkTurn(physical[1]!, requests[1]!, harness.partitionId, false, shape);
      const reopened = await openMongoSagaTurnRepository(stack.db, harness.partitionId);
      const snapshot = await reopened.load(id);
      const aggregate = createSagaAggregate();
      let replay = aggregate.initialState;
      for await (const commit of snapshot.commits) {
        for (const event of commit.events) replay = aggregate.apply(replay, event as Event);
      }
      expect(replay.businessState).toEqual({ count: 2 });
      expect(await streamCommits(harness, id)).toEqual(physical);
      await publishCommit(stack, first);
      await publishCommit(stack, second);
      await settled(harness, observed, second.id, `${label}-paid`, 'ack', 4);
      expect(await streamCommits(harness, id)).toEqual(physical);
      expect(requests).toHaveLength(2);
      await publishCommit(stack, { ...second, events: second.events.map(event => ({ ...event,
        payload: { orderId, changed: true } })) });
      await settled(harness, observed, second.id, `${label}-paid`, 'nack', 5);
      await waitForDeadLetter(harness);
      expect(await streamCommits(harness, id)).toEqual(physical);
    } finally { await harness.close(); }
  });

  it.each(['invalid-start', 'invalid-on'] as const)('rejects %s last intent before any physical append or ACK', async mode => {
    const { definition, table } = createIntentTable(`intent-${mode}`, mode);
    const observed = trace();
    const harness = await createScenario(stack, `intent-${mode}`, table,
      { channel: base => observeIdentitySettlements(base, observed) });
    try {
      const orderId = `order-intent-${mode}`;
      const id = instanceId(definition.sagaKey, orderId);
      if (mode === 'invalid-on') {
        await appendSourceCommit(stack, { id: `${mode}-first`, streamId: `${mode}-input`,
          events: [sourceEvent(`${mode}-placed`, 'real.order-placed.v1.event', { orderId })] });
        await settled(harness, observed, `${mode}-first`, `${mode}-placed`, 'ack', 1);
      }
      const before = await streamCommits(harness, id);
      await appendSourceCommit(stack, { id: `${mode}-bad`, streamId: `${mode}-input`,
        events: [sourceEvent(`${mode}-event`, mode === 'invalid-on' ? 'real.order-paid.v1.event' : 'real.order-placed.v1.event', { orderId })] });
      await settled(harness, observed, `${mode}-bad`, `${mode}-event`, 'nack', mode === 'invalid-on' ? 2 : 1);
      await waitForDeadLetter(harness);
      expect(await streamCommits(harness, id)).toEqual(before);
      expect(observed.settled.some(item => item.kind === 'ack' && item.messageId === `${mode}-bad`)).toBe(false);
    } finally { await harness.close(); }
  });

  it('refuses a persisted unknown intent version on restart without a new commit or ACK', async () => {
    const { definition, table } = createIntentTable('intent-version');
    const observed = trace();
    const harness = await createScenario(stack, 'intent-version', table,
      { channel: base => observeIdentitySettlements(base, observed) });
    try {
      const orderId = 'order-intent-version';
      const id = instanceId(definition.sagaKey, orderId);
      await appendSourceCommit(stack, { id: 'version-first', streamId: 'version-input',
        events: [sourceEvent('version-placed', 'real.order-placed.v1.event', { orderId })] });
      await settled(harness, observed, 'version-first', 'version-placed', 'ack', 1);
      const collection = stack.db.collection(`tw_${harness.partitionId}_commits`);
      const changed = await collection.updateOne({ streamId: id, commitSequence: 0 },
        { $set: { 'events.4.payload.schemaVersion': 2 } });
      expect(changed.modifiedCount).toBe(1);
      const before = await streamCommits(harness, id);
      await appendSourceCommit(stack, { id: 'version-second', streamId: 'version-input',
        events: [sourceEvent('version-paid', 'real.order-paid.v1.event', { orderId })] });
      await settled(harness, observed, 'version-second', 'version-paid', 'nack', 2);
      await waitForDeadLetter(harness);
      expect(await streamCommits(harness, id)).toEqual(before);
    } finally { await harness.close(); }
  });

  it('redelivers after a complete intent commit but before ACK and reconciles on replacement worker', async () => {
    const { definition, table } = createIntentTable('intent-ack-crash');
    const observed = trace();
    const armed = { value: false };
    let release: () => void = () => undefined;
    const closed = new Promise<void>(resolve => { release = resolve; });
    const harness = await createScenario(stack, 'intent-ack-crash', table, {
      channel: base => {
        const watched = observeIdentitySettlements(base, observed);
        return { ...watched, ack: (message, allUpTo) => {
          if (armed.value) throw new Error('injected ACK failure');
          watched.ack(message, allUpTo);
        } };
      },
      onSettlementError: async (_failure, base: Channel) => { await base.close(); release(); }
    });
    let replacement: Awaited<ReturnType<typeof startReplacementWorker>> | undefined;
    try {
      const orderId = 'order-intent-ack-crash';
      const id = instanceId(definition.sagaKey, orderId);
      await appendSourceCommit(stack, { id: 'crash-first', streamId: 'crash-input',
        events: [sourceEvent('crash-placed', 'real.order-placed.v1.event', { orderId })] });
      await settled(harness, observed, 'crash-first', 'crash-placed', 'ack', 1);
      armed.value = true;
      await appendSourceCommit(stack, { id: 'crash-second', streamId: 'crash-input',
        events: [sourceEvent('crash-paid', 'real.order-paid.v1.event', { orderId })] });
      await pollUntil('complete commit before ACK failure', async () =>
        (await streamCommits(harness, id)).length === 2 && harness.settlementErrors.length === 1);
      const committed = await streamCommits(harness, id);
      expect(committed[1]?.events).toHaveLength(10);
      expect(observed.settled).toHaveLength(1);
      await closed;
      const replacementTrace = replacementObservations();
      replacement = await startReplacementWorker(stack, harness, table, replacementTrace.observer);
      await pollUntil('replacement ACK', () => replacementTrace.acks.includes('crash-second'));
      await waitForQueueSettled(harness.queue);
      expect(replacementTrace.deliveries).toContainEqual({ id: 'crash-second', redelivered: true });
      expect(replacementTrace.outcomes).toContainEqual(['reconciled']);
      expect(replacementTrace.acks).toEqual(['crash-second']);
      expect(await streamCommits(harness, id)).toEqual(committed);
      expect(await queueCounts(harness.deadQueue)).toEqual({ ready: 0, unacknowledged: 0 });
    } finally {
      if (replacement) await replacement.close();
      await harness.close();
    }
  });

  it('reconciles an ambiguous intent append before ACK without duplicating the physical turn', async () => {
    const { definition, table } = createIntentTable('intent-ambiguous');
    const observed = trace();
    let injected = false;
    const requests: SagaTurnAppendRequest[] = [];
    const harness = await createScenario(stack, 'intent-ambiguous', table, {
      channel: base => observeIdentitySettlements(base, observed),
      repository: base => wrapRepository(base, async request => {
        requests.push(request);
        const result = await base.append(request);
        if (!injected) { injected = true; throw new Error('lost append response'); }
        return result;
      })
    });
    try {
      const orderId = 'order-intent-ambiguous';
      const id = instanceId(definition.sagaKey, orderId);
      await appendSourceCommit(stack, { id: 'ambiguous-first', streamId: 'ambiguous-input',
        events: [sourceEvent('ambiguous-placed', 'real.order-placed.v1.event', { orderId })] });
      const identity = { messageId: 'ambiguous-first', sourceEventId: 'ambiguous-placed' };
      await pollUntil('ambiguous redelivery reconciled and ACKed', () =>
        observed.received.length >= 2 && observed.settled.length >= 2);
      await waitForQueueSettled(harness.queue);
      expect(observed.received).toEqual([identity, identity]);
      expect(observed.settled).toEqual([{ ...identity, kind: 'nack', requeue: true }, { ...identity, kind: 'ack' }]);
      expect(injected).toBe(true);
      expect(requests).toHaveLength(1);
      const commits = await streamCommits(harness, id);
      expect(commits).toHaveLength(1);
      assertPhysicalTurn(commits[0]!, requests[0]!, harness.partitionId, 0);
      expect(await queueCounts(harness.deadQueue)).toEqual({ ready: 0, unacknowledged: 0 });
    } finally { await harness.close(); }
  });

  it.each(['start', 'on'] as const)('concurrent same-ID %s decisions reconcile full intent content once', async phase => {
    const label = `intent-duplicate-${phase}`;
    const { definition, table } = createIntentTable(label);
    const observed = trace();
    let control: ReturnType<typeof concurrentIntents>;
    const harness = await createScenario(stack, label, table, { prefetch: 5,
      channel: base => observeIdentitySettlements(base, observed),
      repository: base => { control = concurrentIntents(base); return control.repository; } });
    try {
      const orderId = `order-${label}`;
      const id = instanceId(definition.sagaKey, orderId);
      if (phase === 'on') {
        await appendSourceCommit(stack, { id: `${label}-first`, streamId: `${label}-input`,
          events: [sourceEvent(`${label}-placed`, 'real.order-placed.v1.event', { orderId })] });
        await settled(harness, observed, `${label}-first`, `${label}-placed`, 'ack', 1);
        control!.requests.length = 0;
        control!.statuses.length = 0;
      }
      control!.arm();
      const update = await appendSourceCommit(stack, { id: `${label}-update`, streamId: `${label}-input`,
        events: [sourceEvent(`${label}-event`, phase === 'on' ? 'real.order-paid.v1.event' : 'real.order-placed.v1.event', { orderId })] });
      await publishCommit(stack, update);
      await pollUntil('both competing append outcomes', () => control!.statuses.length === 2);
      await waitForQueueSettled(harness.queue);
      expect(control!.statuses.sort()).toEqual(['committed', 'reconciled']);
      expect(control!.requests).toHaveLength(2);
      expect(control!.requests[0]).toEqual(control!.requests[1]);
      const commits = await streamCommits(harness, id);
      expect(commits).toHaveLength(phase === 'on' ? 2 : 1);
      assertPhysicalTurn(commits[phase === 'on' ? 1 : 0]!, control!.requests[0]!, harness.partitionId,
        phase === 'on' ? 12 : 0);
      expect(observed.settled.map(item => item.kind)).toEqual(phase === 'on' ? ['ack', 'ack', 'ack'] : ['ack', 'ack']);
      expect(await queueCounts(harness.deadQueue)).toEqual({ ready: 0, unacknowledged: 0 });
    } finally { await harness.close(); }
  });

  it('retries real OCC between distinct intentful on decisions without dropping either complete turn', async () => {
    const { definition, table } = createIntentTable('intent-occ');
    const observed = trace();
    let control: ReturnType<typeof concurrentIntents>;
    const harness = await createScenario(stack, 'intent-occ', table, { prefetch: 5,
      channel: base => observeIdentitySettlements(base, observed),
      repository: base => { control = concurrentIntents(base); return control.repository; } });
    try {
      const orderId = 'order-intent-occ';
      const id = instanceId(definition.sagaKey, orderId);
      await appendSourceCommit(stack, { id: 'occ-first', streamId: 'occ-input',
        events: [sourceEvent('occ-placed', 'real.order-placed.v1.event', { orderId })] });
      await settled(harness, observed, 'occ-first', 'occ-placed', 'ack', 1);
      control!.requests.length = 0;
      control!.statuses.length = 0;
      control!.arm();
      await Promise.all(['a', 'b'].map(part => appendSourceCommit(stack, { id: `occ-${part}`, streamId: `occ-${part}-input`,
        events: [sourceEvent(`occ-${part}-paid`, 'real.order-paid.v1.event', { orderId })] })));
      await pollUntil('OCC retry finishes', () => control!.statuses.length === 3);
      await waitForQueueSettled(harness.queue);
      expect(control!.statuses.sort()).toEqual(['committed', 'committed', 'conflict']);
      const commits = await streamCommits(harness, id);
      expect(commits).toHaveLength(3);
      for (const [index, commit] of commits.entries()) {
        if (index === 0) continue;
        const accepted = control!.outcomes.find(item => item.status === 'committed' && item.request.commitId === commit.id);
        if (!accepted) throw new Error('missing accepted OCC request');
        assertPhysicalTurn(commit, accepted.request, harness.partitionId, 12 + (index - 1) * 10);
      }
      expect(observed.settled.map(item => item.kind)).toEqual(['ack', 'ack', 'ack']);
      expect(await queueCounts(harness.deadQueue)).toEqual({ ready: 0, unacknowledged: 0 });
    } finally { await harness.close(); }
  });

  it.each(['start', 'on'] as const)('intentful %s fanout waits for late route and reconciles partial work', async phase => {
    const label = `intent-fanout-${phase}`;
    const { first, late, table } = createFanoutIntentTable(label);
    const observed = trace();
    let fault: ReturnType<typeof gatedFanout>;
    const harness = await createScenario(stack, label, table, { prefetch: 1,
      channel: base => observeIdentitySettlements(base, observed),
      repository: base => { fault = gatedFanout(base, late.registration.sagaKey); return fault.repository; } });
    try {
      const orderId = `order-${label}`;
      const firstId = instanceId(first.registration.sagaKey, orderId);
      const lateId = instanceId(late.registration.sagaKey, orderId);
      if (phase === 'on') {
        await appendSourceCommit(stack, { id: `${label}-first`, streamId: `${label}-input`,
          events: [sourceEvent(`${label}-placed`, 'real.order-placed.v1.event', { orderId })] });
        await settled(harness, observed, `${label}-first`, `${label}-placed`, 'ack', 1);
        fault!.requests.length = 0;
      }
      fault!.arm();
      await appendSourceCommit(stack, { id: `${label}-update`, streamId: `${label}-input`,
        events: [sourceEvent(`${label}-event`, phase === 'on' ? 'real.order-paid.v1.event' : 'real.order-placed.v1.event', { orderId })] });
      await fault!.arrival;
      const count = phase === 'on' ? 2 : 1;
      await pollUntil('first fanout route committed', async () => (await streamCommits(harness, firstId)).length === count);
      expect(await streamCommits(harness, lateId)).toHaveLength(count - 1);
      const identity = { messageId: `${label}-update`, sourceEventId: `${label}-event` };
      await pollUntil('gated delivery observed', () => observed.received.some(item =>
        item.messageId === identity.messageId && item.sourceEventId === identity.sourceEventId));
      expect(observed.received.filter(item => item.messageId === identity.messageId)).toEqual([identity]);
      expect(observed.settled.filter(item => item.messageId === identity.messageId)).toEqual([]);
      fault!.release();
      await pollUntil('both fanout routes committed and ACKed', async () =>
        (await streamCommits(harness, lateId)).length === count &&
        observed.settled.some(item => item.kind === 'ack' && item.messageId === `${label}-update`));
      await waitForQueueSettled(harness.queue);
      expect(observed.settled.filter(item => item.messageId === `${label}-update`).map(item => [item.kind, item.requeue]))
        .toEqual([['nack', true], ['ack', undefined]]);
      expect(observed.received.filter(item => item.messageId === identity.messageId)).toEqual([identity, identity]);
      const sourceTriggerId = deriveSourceTriggerId({ partitionId: stack.sourcePartitionId,
        streamId: `${label}-input`, commitId: `${label}-update`, eventIndex: 0 });
      for (const id of [firstId, lateId]) {
        const commits = await streamCommits(harness, id);
        expect(commits).toHaveLength(count);
        expect(commits[count - 1]).toMatchObject({ sagaTurnIdentity: { sourceTriggerId } });
        const request = fault!.requests.find(item => item.streamId === id);
        if (!request) throw new Error('missing fanout request');
        assertPhysicalTurn(commits[count - 1]!, request, harness.partitionId, phase === 'on' ? 12 : 0);
      }
      expect(await queueCounts(harness.deadQueue)).toEqual({ ready: 0, unacknowledged: 0 });
    } finally { fault!.release(); await harness.close(); }
  });

  it('never ACKs intentful on fanout when the later route emits an invalid final intent', async () => {
    const { first, late, table } = createFanoutIntentTable('intent-fanout-invalid', 'invalid-on');
    const observed = trace();
    const requests: SagaTurnAppendRequest[] = [];
    const harness = await createScenario(stack, 'intent-fanout-invalid', table, { prefetch: 1,
      channel: base => observeIdentitySettlements(base, observed),
      repository: base => wrapRepository(base, async request => { requests.push(request); return base.append(request); }) });
    try {
      const orderId = 'order-intent-fanout-invalid';
      const firstId = instanceId(first.registration.sagaKey, orderId);
      const lateId = instanceId(late.registration.sagaKey, orderId);
      await appendSourceCommit(stack, { id: 'fanout-valid-start', streamId: 'fanout-invalid-input',
        events: [sourceEvent('fanout-valid-placed', 'real.order-placed.v1.event', { orderId })] });
      await settled(harness, observed, 'fanout-valid-start', 'fanout-valid-placed', 'ack', 1);
      for (const id of [firstId, lateId]) {
        const [commit] = await streamCommits(harness, id);
        const request = requests.find(item => item.streamId === id);
        if (!commit || !request) throw new Error('missing fanout start');
        assertPhysicalTurn(commit, request, harness.partitionId, 0);
      }
      await appendSourceCommit(stack, { id: 'fanout-invalid-on', streamId: 'fanout-invalid-input',
        events: [sourceEvent('fanout-invalid-paid', 'real.order-paid.v1.event', { orderId })] });
      await settled(harness, observed, 'fanout-invalid-on', 'fanout-invalid-paid', 'nack', 2);
      await waitForDeadLetter(harness);
      const firstCommits = await streamCommits(harness, firstId);
      expect(firstCommits).toHaveLength(2);
      const on = requests.find(item => item.streamId === firstId && item.expectedNextCommitSequence === 1);
      if (!on) throw new Error('missing first on request');
      assertPhysicalTurn(firstCommits[1]!, on, harness.partitionId, 12);
      expect(await streamCommits(harness, lateId)).toHaveLength(1);
      expect(requests.filter(item => item.streamId === lateId)).toHaveLength(1);
      expect(observed.settled.map(item => item.kind)).toEqual(['ack', 'nack']);
    } finally { await harness.close(); }
  });
});
