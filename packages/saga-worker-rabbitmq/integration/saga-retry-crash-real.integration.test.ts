import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, jest } from '@jest/globals';
import { connect, type Channel, type ConfirmChannel } from 'amqplib';
import { MongoClient } from 'mongodb';
import { deriveSourceTriggerId } from '@redemeine/saga-runtime';
import type { ICommit } from 'tapeworm';
import { counts, deadQueue, input, provision, required, retryQueue } from './crashBroker';
import { observationWindowMs, observeHeldCopy, requireKillProof, safeCounts, type CountSample } from './crashCountProof';
import { awaitChildReady, awaitSignal, isCrashSignal, killOwned, type CrashSignal } from './crashIpc';
import { cleanupSucceeded, deadline, OwnedCrashScope, type CleanupOutcome, type OwnedCleanup } from './crashOwnership';
import { PhaseEvidence } from './crashPhaseEvidence';
import { deriveOwnedNames } from './crashNames';
import { createDbOwner, ownedEnvironment, ownedOps } from './crashResourceOps';
import { runCrashLifecycle } from './crashRunLifecycle';
import { proveMaterial, proveUnchanged } from './crashMaterialProof';
import { proveMismatchSignals, proveRecoverySignals } from './crashRecoveryProof';
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
  readonly exchange: string; readonly original: ICommit; readonly sagaId: string; readonly sagaKey: string };

function material(stack: Stack, rows: readonly unknown[]) {
  return proveMaterial(rows, { sagaId: stack.sagaId, sagaKey: stack.sagaKey,
    partition: required('REDEMEINE_CRASH_SAGA_PARTITION'), eventId: 'crash-event', amount: 1,
    sourcePartition: stack.original.partitionId, sourceStream: stack.original.streamId, sourceCommit: stack.original.id,
    sourceTriggerId: deriveSourceTriggerId({ partitionId: stack.original.partitionId,
      streamId: stack.original.streamId, commitId: stack.original.id, eventIndex: 0 }) });
}

async function crashPhase(stack: Stack, first: ChildProcess, phases: PhaseEvidence): Promise<unknown[]> {
  const { client, pub, original, sagaId } = stack;
  const dbName = required('REDEMEINE_CRASH_DB');
  const sagaPartition = required('REDEMEINE_CRASH_SAGA_PARTITION');
  await phases.run('source-append', () => client.db(dbName).collection(required('REDEMEINE_CRASH_COLLECTION')).insertOne(original));
  await phases.run('child-ready', () => awaitChildReady(first, trace), 7_000);
  await phases.run('source-publish', () => publish(pub, stack.exchange, original, required('REDEMEINE_CRASH_COLLECTION')));
  await phases.run('initial-delivery', () => until('initial Rabbit delivery', () =>
    trace.some(event => event.kind === 'delivery' && event.messageId === original.id), 6_000), 7_000);
  await phases.run('retry-confirm', () => until('confirmed retry', () => trace.some(event =>
    event.kind === 'confirmed' && event.messageId === original.id), 15_000), 16_000);
  const confirmedAt = Date.now();
  const samples: CountSample[] = [];
  evidence.brokerObservation = { windowMs: observationWindowMs, samples };
  const readCount = (queue: 'input' | 'retry') => counts(queue === 'input' ? input : retryQueue);
  await phases.run('broker-observation', () => observeHeldCopy(readCount, samples, confirmedAt), 11_000);
  const committed = await phases.run('physical-commit-read', () => physical(client, dbName, sagaPartition, sagaId));
  const atKill = await phases.run('crash-assertions', async () => {
    expect(trace.find(event => event.kind === 'confirmed')).toMatchObject({ messageId: original.id, attempt: 1 });
    const facts = material(stack, committed);
    const proof = await observeHeldCopy(readCount, samples, confirmedAt);
    evidence.atKill = { input: safeCounts(proof.input), retry: safeCounts(proof.retry),
      ...facts };
    expect(evidence.atKill).toMatchObject({ physical: 1, input: { unacked: 1, ack: 0 }, retry: { ready: 1 } });
    return proof;
  }, 11_000);
  evidence.exitSignal = await phases.run('kill-eligibility', async () => {
    requireKillProof(atKill, confirmedAt);
    return killOwned(first);
  });
  evidence.requeued = await phases.run('original-requeue', async () => {
    await until('original requeued', async () => (await counts(input)).ready === 1);
    return counts(input);
  }, 17_000);
  return committed;
}

async function recoveryPhase(stack: Stack, recovery: ChildProcess, committed: unknown[], phases: PhaseEvidence): Promise<void> {
  const { client, original, sagaId } = stack;
  const started = Date.now();
  const summary = { ready: false, originalAcks: 0, ttlAcks: 0, deliveries: 0,
    redelivered: false, attempt: null as number | null, deathCount: null as number | null,
    statuses: 0, elapsedMs: 0, physical: null as number | null, materialMatches: false };
  evidence.recovery = summary;
  await phases.run('recovery-ready', () => awaitChildReady(recovery, trace), 7_000);
  summary.ready = true;
  await phases.run('recovery-original-ack', () => until('original requeue ACK', () =>
    trace.some(event => event.kind === 'ack' && event.messageId === original.id)), 17_000);
  summary.originalAcks = trace.filter(event => event.kind === 'ack' && event.messageId === original.id).length;
  await phases.run('recovery-ttl-ack', () => until('TTL-returned retry ACK', () =>
    trace.filter(event => event.kind === 'ack' && event.messageId === original.id).length >= 2, 40_000), 41_000);
  summary.ttlAcks = trace.filter(event => event.kind === 'ack' && event.messageId === original.id).length;
  const deliveries = trace.filter((event): event is Exclude<CrashSignal, { kind: 'error' }> =>
    event.kind === 'delivery' && event.messageId === original.id);
  summary.deliveries = deliveries.length;
  await phases.run('recovery-deliveries', () => {
    expect(deliveries).toHaveLength(3);
    expect(summary.originalAcks).toBe(1);
    expect(summary.ttlAcks).toBe(2);
    expect(deliveries[1]).toMatchObject({ redelivered: true, attempt: undefined });
    summary.redelivered = true;
  });
  await phases.run('recovery-death-attempt', () => {
    const returned = deliveries[2];
    summary.attempt = returned?.attempt ?? null;
    const deaths = returned?.deaths;
    if (!Array.isArray(deaths) || deaths.length !== 1) throw new Error('unexpected retry death shape');
    const death = deaths[0] as Record<string, unknown>;
    summary.deathCount = typeof death.count === 'number' ? death.count : null;
    expect(returned).toMatchObject({ attempt: 1, deaths: [{ queue: retryQueue, reason: 'expired', count: 1 }] });
  });
  await phases.run('recovery-statuses', () => {
    const statuses = trace.filter((event): event is Exclude<CrashSignal, { kind: 'error' }> =>
      event.kind === 'processed' && event.messageId === 'crash-event');
    summary.statuses = statuses.length;
    proveRecoverySignals(trace, original.id, 'crash-event', retryQueue);
  });
  const after = await phases.run('recovery-physical-read', () => physical(client,
    required('REDEMEINE_CRASH_DB'), required('REDEMEINE_CRASH_SAGA_PARTITION'), sagaId));
  summary.physical = after.length;
  await phases.run('recovery-material', () => { material(stack, after); proveUnchanged(committed, after); });
  summary.materialMatches = true;
  summary.elapsedMs = Math.min(110_000, Date.now() - started);
}

async function mismatchPhase(stack: Stack, recovery: ChildProcess, committed: unknown[], phases: PhaseEvidence): Promise<void> {
  const { channel, pub, original, client, sagaId } = stack;
  const summary = { published: false, confirmedDead: false, ackCount: 0, dlqReady: false,
    copyMatches: false, settled: false, physical: null as number | null, materialMatches: false };
  evidence.mismatch = summary;
  const dead = awaitSignal(recovery, (event) => event.kind === 'dead' && event.messageId === original.id);
  await phases.run('mismatch-publish', () => publish(pub, stack.exchange,
    makeCommit(original.partitionId, 99), required('REDEMEINE_CRASH_COLLECTION')));
  summary.published = true;
  await phases.run('mismatch-dead', () => dead, 16_000);
  summary.confirmedDead = true;
  await phases.run('mismatch-ack', async () => {
    await until('changed copy ACK', () =>
      trace.filter((event) => event.kind === 'ack' && event.messageId === original.id).length >= 3);
    proveMismatchSignals(trace, original.id);
  }, 16_000);
  summary.ackCount = trace.filter(event => event.kind === 'ack' && event.messageId === original.id).length;
  await phases.run('mismatch-dlq', async () => {
    await until('changed copy in DLQ', async () => (await counts(deadQueue)).ready === 1);
    summary.dlqReady = true;
    const copy = await channel.get(deadQueue, { noAck: false });
    expect(copy && copy.properties.messageId).toBe(original.id);
    expect(copy && JSON.parse(copy.content.toString()).events[0].payload.amount).toBe(99);
    summary.copyMatches = true;
    if (copy) channel.ack(copy);
  }, 17_000);
  await phases.run('mismatch-settled', () => until('input settled', async () => {
    const value = await counts(input); return value.ready === 0 && value.unacked === 0;
  }), 16_000);
  summary.settled = true;
  const finalRows = await phases.run('mismatch-material', async () => {
    const rows = await physical(client, required('REDEMEINE_CRASH_DB'), required('REDEMEINE_CRASH_SAGA_PARTITION'), sagaId);
    summary.physical = rows.length;
    material(stack, rows);
    proveUnchanged(committed, rows);
    return rows;
  });
  summary.materialMatches = true;
  evidence.final = await phases.run('mismatch-final-counts', async () => ({ input: await counts(input),
    retry: await counts(retryQueue), dead: await counts(deadQueue),
    physicalTurns: finalRows.length, originalPrefixAcks: trace.filter(event => event.kind === 'ack' && event.messageId === original.id).length - 1,
    mismatchConfirmedDlq: true }), 16_000);
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
  const identity = deriveOwnedNames(required('REDEMEINE_REAL_RUN_ID'));
  const names = identity.owned;
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
  evidence.mongoIdentity = { db: names.db, hashPrefix: identity.digest, hash: 'sha256-96',
    sagaPartition: identity.mongo.sagaPartition, sourceCollection: identity.mongo.sourceCollection };
  await runCrashLifecycle(async () => {
    await phases.run('mongo-connect', () => client.connect());
    await phases.run('resource-preflight', () => scopeOwner.preflight(), 16_000);
    try { await phases.run('resource-setup', () => scopeOwner.setup(), 16_000); }
    finally { evidence.userOwner = scopeOwner.userOwnership; }
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
       sagaKey: createRealTable('crash-proof', createCounters()).definition.sagaKey,
       sagaId: instanceId(createRealTable('crash-proof', createCounters()).definition.sagaKey, 'crash-order') }));
    first = await phases.run('child-fork', () => child('first', env));
    const committed = await crashPhase(stack, first, phases);
    const replacement = await phases.run('recovery-fork', () => child('recovery', env));
    recovery = replacement;
    await recoveryPhase(stack, replacement, committed, phases);
    await mismatchPhase(stack, replacement, committed, phases);
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
