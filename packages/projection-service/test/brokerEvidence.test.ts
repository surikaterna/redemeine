import { BrokerEvidence } from '../src/infrastructure/brokerEvidence';
import { BrokerTopology } from '../src/infrastructure/brokerTopology';
import { bootstrapIdentity, brokerStart, preparedRecord } from '../src/infrastructure/bootstrapRecord';
import { builtArtifact } from './fixtures';
import { externalConfig } from './support/mongoClient';
import { ManagementFixture } from './support/brokerManagement';
import { modelCommit } from '../src/reference/scenario';
import { admitLiveDelivery } from '@redemeine/projection-transport';
import type { LiveSourceOrderPort } from '@redemeine/projection-runtime-core';
import { deferred } from './support/deferred';

async function fixture() {
  const config = externalConfig(); const record = preparedRecord(bootstrapIdentity(config, await builtArtifact())); const start = brokerStart(record, config);
  const management = new ManagementFixture(config); management.declare(record.queueNonce); management.bind();
  const identity = { connectionLabel: 'actual-owned', channelNumber: 1, peerHost: '127.0.0.1', peerPort: 12345,
    host: '127.0.0.1', port: 5672, user: 'user' };
  management.consume('actual-tag', identity);
  const delivery = { sessionRef: 'session', deliveryTag: 1, messageId: modelCommit(42).commitId, redelivered: false };
  let now = 0;
  const evidence = new BrokerEvidence(start, { identity: () => identity, assertCurrent: () => {},
    consumerTag: () => 'actual-tag', owns: (candidate) => candidate === delivery }, new BrokerTopology(config, management), () => now);
  const result = await evidence.openSession(start, { sessionRef: 'session', queueName: start.queueName, prefetch: 1,
    exclusive: false, consumerMode: 'single_active' });
  if (result.status !== 'staged') throw new Error('missing_session');
  return { evidence, start, management, identity, delivery, session: result.value, activate: result.value.activateConsumer, setNow: (value: number) => { now = value; } };
}

test('broker witness preserves exact start/session and actual reserved delivery; descriptor forgery cannot reserve', async () => {
  const f = await fixture();
  await f.activate('actual-tag'); expect(f.session.start).toBe(f.start);
  expect(() => f.session.reserve({ ...f.delivery })).toThrow('broker_reservation_mismatch');
  f.session.reserve(f.delivery);
  const first = await f.session.certifyFirst(modelCommit(42), f.delivery);
  expect(first).toMatchObject({ status: 'qualified', value: { kind: 'broker_first_retained_delivery',
    position: { firstSequence: 42, coveredThrough: null } } });
  if (first.status !== 'qualified') throw new Error('missing_witness');
  expect(first.value.start).toBe(f.start); expect(first.value.delivery).toBe(f.delivery);
  f.session.settled(f.delivery);
  expect(() => first.value.assertCurrent()).toThrow(); await f.evidence.close();
});

test('staleness is checked against elapsed monotonic time even when refresh timer has not fired', async () => {
  const f = await fixture(); await f.activate('actual-tag'); f.setNow(10000);
  expect(() => f.session.assertCurrent()).toThrow('broker_session_expired');
  expect(() => f.session.reserve(f.delivery)).toThrow(); await f.evidence.close();
});

test('periodic five-second topology drift invalidates rather than silently requalifying', async () => {
  jest.useFakeTimers();
  try {
    const f = await fixture(); await f.activate('actual-tag'); f.management.operators = [{ pattern: '.*' }]; f.setNow(5000);
    await jest.advanceTimersByTimeAsync(5000);
    expect(() => f.session.assertCurrent()).toThrow('broker_session_expired');
    f.management.operators = [];
    expect(() => f.session.assertCurrent()).toThrow(); await f.evidence.close();
  } finally { jest.useRealTimers(); }
});

test('wrong consume-ok tag and reference start cannot activate broker session', async () => {
  const f = await fixture(); await expect(f.activate('forged')).rejects.toThrow('broker_session_expired');
  expect(await f.evidence.openSession(f.start, { sessionRef: 'forged', queueName: f.start.queueName, prefetch: 1, exclusive: true }))
    .toMatchObject({ status: 'unproven' });
  await f.evidence.close();
});

test('known broker floor refuses resumed below-F publication without admitting a replacement floor', async () => {
  const f = await fixture(); await f.activate('actual-tag');
  const older = modelCommit(41); f.delivery.messageId = older.commitId;
  const admitFirst = jest.fn(async () => { throw new Error('unexpected_admission'); });
  const order: LiveSourceOrderPort = { async load() { return { epoch: f.start.epoch, registryDigest: f.start.registryDigest,
    sourceId: older.streamId, firstSequence: 42, firstCommitId: modelCommit(42).commitId, coveredThrough: 42 }; },
    admitFirst, advanceCoverage: async () => { throw new Error('unexpected_coverage'); } };
  await expect(admitLiveDelivery(order, f.session, older, f.delivery)).rejects.toThrow('live_continuity_violation');
  expect(admitFirst).not.toHaveBeenCalled(); await f.evidence.close();
});

test('pending initial activation grants no session witness until exact consumer is observed', async () => {
  const f = await fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
  f.management.queueValue.consumer_details = []; f.management.queueValue.consumers = 0;
  jest.useFakeTimers();
  try {
    const task = f.activate('actual-tag'); await jest.advanceTimersByTimeAsync(100);
    expect(() => f.session.assertCurrent()).toThrow('broker_session_expired');
    expect(() => f.session.reserve(f.delivery)).toThrow(); expect(f.evidence.hasObservedFault()).toBe(false);
    f.management.consume('actual-tag', f.identity); await jest.advanceTimersByTimeAsync(100); await task;
    expect(() => f.session.assertCurrent()).not.toThrow(); await f.evidence.close(); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test.each(['absent', 0, 1])('after activation, empty details with count %p permanently faults rather than renewing staging', async (count) => {
  const f = await fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
  jest.useFakeTimers();
  try {
    await f.activate('actual-tag'); f.management.queueValue.consumer_details = [];
    if (count === 'absent') delete f.management.queueValue.consumers; else f.management.queueValue.consumers = count;
    f.setNow(5000); await jest.advanceTimersByTimeAsync(5000);
    expect(f.evidence.hasObservedFault()).toBe(true); f.management.consume('actual-tag', f.identity);
    await jest.advanceTimersByTimeAsync(100); expect(() => f.session.assertCurrent()).toThrow(); await f.evidence.close();
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('unknown initial count forever times out without witness, then cannot revive', async () => {
  const f = await fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
  f.management.queueValue.consumer_details = []; delete f.management.queueValue.consumers;
  jest.useFakeTimers();
  try {
    const result = f.activate('actual-tag').catch((error: unknown) => error); await jest.advanceTimersByTimeAsync(9999);
    expect(() => f.session.reserve(f.delivery)).toThrow(); expect(f.evidence.hasObservedFault()).toBe(false);
    await jest.advanceTimersByTimeAsync(1); expect(await result).toMatchObject({ reason: 'broker_consumer_activation_deadline' });
    expect(f.evidence.hasObservedFault()).toBe(true); f.management.consume('actual-tag', f.identity);
    await jest.advanceTimersByTimeAsync(100); expect(() => f.session.assertCurrent()).toThrow();
    await f.evidence.close(); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('foreign consumer following unknown initial stats fails immediately and cannot establish a witness', async () => {
  const f = await fixture(); if (!f.management.queueValue) throw new Error('missing_queue');
  f.management.queueValue.consumer_details = []; delete f.management.queueValue.consumers;
  jest.useFakeTimers();
  try {
    const result = f.activate('actual-tag').catch((error: unknown) => error); await jest.advanceTimersByTimeAsync(100);
    f.management.consume('foreign-tag', f.identity); await jest.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ reason: 'broker_consumer_tag_mismatch' });
    expect(() => f.session.reserve(f.delivery)).toThrow(); expect(f.evidence.hasObservedFault()).toBe(true);
    await f.evidence.close(); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('close joins a late initial inspection after bounded activation timeout; no late activation', async () => {
  const f = await fixture(); const pending = deferred<void>(); f.management.gate = pending.promise;
  jest.useFakeTimers();
  try {
    const result = f.activate('actual-tag').catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(10000); expect(await result).toMatchObject({ reason: 'broker_consumer_activation_deadline' });
    let closed = false; const closing = f.evidence.close().then(() => { closed = true; });
    await jest.advanceTimersByTimeAsync(0); expect(closed).toBe(false); pending.resolve();
    await jest.advanceTimersByTimeAsync(0); await closing; expect(closed).toBe(true);
    expect(() => f.session.assertCurrent()).toThrow(); expect(f.evidence.hasObservedFault()).toBe(true); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
