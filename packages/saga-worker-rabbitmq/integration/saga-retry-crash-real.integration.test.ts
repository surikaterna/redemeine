import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, jest } from '@jest/globals';
import { connect, type Channel, type ConfirmChannel } from 'amqplib';
import { MongoClient } from 'mongodb';
import type { ICommit } from 'tapeworm';
import { counts, deadQueue, input, provision, required, retryQueue } from './crashBroker';
import { awaitSignal, isCrashSignal, killOwned, type CrashSignal } from './crashIpc';
import { cleanupSucceeded, deadline, OwnedCrashScope, type CleanupOutcome, type OwnedCleanup } from './crashOwnership';
import { PhaseEvidence } from './crashPhaseEvidence';
import { createDbOwner, ownedEnvironment, ownedNames, ownedOps } from './crashResourceOps';
import { runCrashLifecycle } from './crashRunLifecycle';
import { instanceId, sourceEvent } from './harness';
import { createCounters, createRealTable } from './fixtures';

jest.setTimeout(110_000);

const issue = 'redemeine-fyp3.5.3.1';
const childPath = resolve(process.cwd(), 'packages/saga-worker-rabbitmq/integration/crashChild.ts');
const trace: CrashSignal[] = [];
const evidence: Record<string, unknown> = { issue, trace, success: false };
function child(mode: 'first' | 'recovery', env: NodeJS.ProcessEnv): ChildProcess {
  const processChild = fork(childPath, { execArgv: ['--import', 'tsx'], env: { ...process.env, ...env,
    REDEMEINE_CRASH_MODE: mode }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  processChild.on('message', (message: unknown) => { if (isCrashSignal(message)) trace.push(message); });
  return processChild;
}

async function until(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out`);
}

async function publish(channel: ConfirmChannel, exchange: string, commit: ICommit, collection: string): Promise<void> {
  await deadline('source broker confirm', () => new Promise<void>((resolve, reject) => {
    channel.publish(exchange, '', Buffer.from(JSON.stringify(commit)), { mandatory: true, persistent: true,
      contentType: 'application/json', messageId: commit.id,
      headers: { collection, partitionId: commit.partitionId, streamId: commit.streamId } },
    (error) => error ? reject(error) : resolve());
  }));
}

function makeCommit(partitionId: string, amount: number): ICommit {
  return { id: 'crash-source-commit', partitionId, streamId: 'crash-source-stream', commitSequence: 0,
    createDateTime: '2026-01-01T00:00:00.000Z',
    events: [{ ...sourceEvent('crash-event', 'real.order-placed.v1.event', { orderId: 'crash-order', amount }), version: 0 }] };
}

async function physical(client: MongoClient, dbName: string, sagaPartition: string, sagaId: string): Promise<unknown[]> {
  return client.db(dbName).collection(`tw_${sagaPartition}_commits`).find({ streamId: sagaId }).toArray();
}

type Stack = { readonly client: MongoClient; readonly channel: Channel; readonly pub: ConfirmChannel;
  readonly exchange: string; readonly original: ICommit; readonly sagaId: string };

async function crashPhase(stack: Stack, first: ChildProcess, phases: PhaseEvidence): Promise<unknown[]> {
  const { client, pub, original, sagaId } = stack;
  const dbName = required('REDEMEINE_CRASH_DB');
  const sagaPartition = required('REDEMEINE_CRASH_SAGA_PARTITION');
  await phases.run('source-append', () => client.db(dbName).collection(required('REDEMEINE_CRASH_COLLECTION')).insertOne(original));
  await phases.run('child-ready', () => awaitSignal(first, event => event.kind === 'ready', 6_000), 7_000);
  await phases.run('source-publish', () => publish(pub, stack.exchange, original, required('REDEMEINE_CRASH_COLLECTION')));
  await phases.run('initial-delivery', () => until('initial Rabbit delivery', () =>
    trace.some(event => event.kind === 'delivery' && event.messageId === original.id), 6_000), 7_000);
  await phases.run('retry-confirm', () => until('confirmed retry', () => trace.some(event =>
    event.kind === 'confirmed' && event.messageId === original.id), 15_000), 16_000);
  expect(trace.find(event => event.kind === 'confirmed')).toMatchObject({ messageId: original.id, attempt: 1 });
  await until('confirmed copy and held original', async () => {
    const a = await counts(input);
    const b = await counts(retryQueue);
    return a.unacked === 1 && a.ack === 0 && b.ready === 1;
  });
  const committed = await physical(client, dbName, sagaPartition, sagaId);
  expect(committed).toHaveLength(1);
  expect(committed[0]).toMatchObject({ events: [
    { type: 'saga.instance_created.event' }, { type: 'saga.definition_identity_recorded.event' },
    { type: 'saga.source_event_observed.event' }, { type: 'saga.business_state_recorded.event' }
  ] });
  evidence.atKill = { input: await counts(input), retry: await counts(retryQueue), physical: committed.length, intentFacts: 0 };
  expect(evidence.atKill).toMatchObject({ physical: 1, input: { unacked: 1, ack: 0 }, retry: { ready: 1 } });
  evidence.exitSignal = await killOwned(first);
  await until('original requeued', async () => (await counts(input)).ready === 1);
  evidence.requeued = await counts(input);
  return committed;
}

async function recoveryPhase(stack: Stack, recovery: ChildProcess, committed: unknown[]): Promise<void> {
  const { client, original, sagaId } = stack;
  await awaitSignal(recovery, (event) => event.kind === 'ready');
  await until('original requeue ACK', () => trace.some((event) => event.kind === 'ack' && event.messageId === original.id));
  await until('TTL-returned retry ACK', () => trace.filter((event) => event.kind === 'ack' && event.messageId === original.id).length === 2,
    40_000);
  const deliveries = trace.filter((event) => event.kind === 'delivery' && event.messageId === original.id);
  expect(deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ redelivered: true, attempt: undefined }),
    expect.objectContaining({ attempt: 1, deaths: [expect.objectContaining({ queue: retryQueue, reason: 'expired', count: 1 })] })
  ]));
  expect(trace.filter((event) => event.kind === 'processed' && event.messageId === 'crash-event')
    .map((event) => event.statuses)).toEqual([['reconciled'], ['reconciled']]);
  expect(await physical(client, required('REDEMEINE_CRASH_DB'), required('REDEMEINE_CRASH_SAGA_PARTITION'), sagaId))
    .toEqual(committed);
}

async function mismatchPhase(stack: Stack, recovery: ChildProcess, committed: unknown[]): Promise<void> {
  const { channel, pub, original, client, sagaId } = stack;
  const dead = awaitSignal(recovery, (event) => event.kind === 'dead' && event.messageId === original.id);
  await publish(pub, stack.exchange, makeCommit(original.partitionId, 99), required('REDEMEINE_CRASH_COLLECTION'));
  await dead;
  await until('changed copy ACK', () => trace.filter((event) => event.kind === 'ack' && event.messageId === original.id).length === 3);
  const deadIndex = trace.findIndex((event) => event.kind === 'dead' && event.messageId === original.id);
  const finalAckIndex = trace.reduce((last, event, index) =>
    event.kind === 'ack' && event.messageId === original.id ? index : last, -1);
  expect(deadIndex).toBeGreaterThanOrEqual(0);
  expect(finalAckIndex).toBeGreaterThan(deadIndex);
  await until('changed copy in DLQ', async () => (await counts(deadQueue)).ready === 1);
  const copy = await channel.get(deadQueue, { noAck: false });
  expect(copy && copy.properties.messageId).toBe(original.id);
  expect(copy && JSON.parse(copy.content.toString()).events[0].payload.amount).toBe(99);
  if (copy) channel.ack(copy);
  await until('input settled', async () => { const value = await counts(input); return value.ready === 0 && value.unacked === 0; });
  expect(await physical(client, required('REDEMEINE_CRASH_DB'), required('REDEMEINE_CRASH_SAGA_PARTITION'), sagaId))
    .toEqual(committed);
  evidence.final = { input: await counts(input), retry: await counts(retryQueue), dead: await counts(deadQueue),
    physicalTurns: 1, originalPrefixAcks: 2, mismatchConfirmedDlq: true };
}

async function cleanOwned(client: MongoClient, model: Awaited<ReturnType<typeof connect>> | undefined,
  scope: OwnedCrashScope, children: readonly (ChildProcess | undefined)[], priorEnv: Record<string, string | undefined>): Promise<void> {
  const unknown: CleanupOutcome = { status: 'failed', reason: 'failed' };
  const cleanup: { ownedChildrenReaped: boolean; resources: OwnedCleanup; amqpClosed: boolean; mongoClosed: boolean } = {
    ownedChildrenReaped: false, resources: { vhost: unknown, user: unknown, db: unknown },
    amqpClosed: false, mongoClosed: false
  };
  try {
    let reaped = true;
    for (const processChild of children) {
      if (processChild && processChild.exitCode === null && processChild.signalCode === null) {
        try { await killOwned(processChild); } catch { reaped = false; }
      }
    }
    cleanup.ownedChildrenReaped = reaped;
    const results = await Promise.allSettled([
      deadline('AMQP close', () => model?.close() ?? Promise.resolve()),
      scope.cleanup()
    ]);
    if (results[1]?.status === 'fulfilled') cleanup.resources = results[1].value;
    cleanup.amqpClosed = results[0]?.status === 'fulfilled';
    cleanup.mongoClosed = await deadline('Mongo close', () => client.close()).then(() => true, () => false);
    if (!cleanup.ownedChildrenReaped || !cleanupSucceeded(cleanup.resources) ||
        !cleanup.amqpClosed || !cleanup.mongoClosed) {
      throw new Error('owned crash resources remain after cleanup');
    }
  } finally {
    evidence.cleanup = cleanup;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

it('kills the real worker after confirmed retry and before ACK, then reconciles and quarantines changed content', async () => {
  const names = ownedNames();
  const password = randomBytes(24).toString('hex');
  const env = ownedEnvironment(names, password);
  const client = new MongoClient(required('REDEMEINE_MONGO_URL'),
    { serverSelectionTimeoutMS: 5_000, socketTimeoutMS: 5_000, connectTimeoutMS: 5_000 });
  const scopeOwner = new OwnedCrashScope(names, ownedOps(names, client, password));
  let first: ChildProcess | undefined;
  let recovery: ChildProcess | undefined;
  let model: Awaited<ReturnType<typeof connect>> | undefined;
  const priorEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const phases = new PhaseEvidence();
  evidence.phases = phases.steps;
  await runCrashLifecycle(async () => {
    await phases.run('mongo-connect', () => client.connect());
    await phases.run('resource-preflight', () => scopeOwner.preflight(), 16_000);
    await phases.run('resource-setup', () => scopeOwner.setup(), 16_000);
    scopeOwner.markDbAttempted();
    await phases.run('mongo-owner-create', () => createDbOwner(client, names));
    Object.assign(process.env, env);
    const openedModel = await phases.run('amqp-open', () => connect(required('REDEMEINE_CRASH_URL')));
    model = openedModel;
    const channel = await phases.run('consumer-channel', () => openedModel.createChannel());
    const pub = await phases.run('confirm-channel', () => openedModel.createConfirmChannel());
    const scope = await phases.run('topology-provision', () => provision(channel), 16_000);
    await phases.run('topology-inspected', () => scope.retry!.inspect());
    evidence.topology = { vhost: env.REDEMEINE_CRASH_VHOST, input, retryQueue, deadQueue,
      inspected: true };
    const stack = await phases.run('stack-construction', (): Stack => ({ client, channel, pub, exchange: scope.sourceExchange,
      original: makeCommit(required('REDEMEINE_CRASH_PARTITION'), 1),
      sagaId: instanceId(createRealTable('crash-proof', createCounters()).definition.sagaKey, 'crash-order') }));
    first = await phases.run('child-fork', () => child('first', env));
    const committed = await crashPhase(stack, first, phases);
    const replacement = await phases.run('recovery', () => child('recovery', env));
    recovery = replacement;
    await phases.run('recovery', () => recoveryPhase(stack, replacement, committed), 50_000);
    await phases.run('recovery', () => mismatchPhase(stack, replacement, committed), 25_000);
    await deadline('confirm channel close', () => pub.close());
    await deadline('consumer channel close', () => channel.close());
  }, () => cleanOwned(client, model, scopeOwner, [first, recovery], priorEnv), async result => {
    evidence.firstFailure = phases.firstFailure;
    evidence.cleanupFailure = result.cleanupFailure;
    evidence.success = result.success;
    await deadline('crash receipt write', () => writeFile(required('REDEMEINE_CRASH_RECEIPT'),
      JSON.stringify(evidence), { mode: 0o600 }));
  }, phases);
}, 110_000);
