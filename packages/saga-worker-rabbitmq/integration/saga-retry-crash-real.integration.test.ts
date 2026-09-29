import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it, jest } from '@jest/globals';
import { connect, type Channel, type ConfirmChannel } from 'amqplib';
import { MongoClient } from 'mongodb';
import type { ICommit } from 'tapeworm';
import { counts, deadQueue, input, management, provision, required, retryQueue } from './crashBroker';
import { awaitSignal, isCrashSignal, killOwned, type CrashSignal } from './crashIpc';
import { instanceId, sourceEvent } from './harness';
import { createCounters, createRealTable } from './fixtures';

jest.setTimeout(110_000);

const issue = 'redemeine-fyp3.5.3.1';
const childPath = fileURLToPath(new URL('./crashChild.ts', import.meta.url));
const trace: CrashSignal[] = [];
const evidence: Record<string, unknown> = { issue, trace, success: false };
const adminUser = required('REDEMEINE_RABBIT_USER');
const adminPassword = required('REDEMEINE_RABBIT_PASSWORD');

async function admin(path: string, method: string, body?: object): Promise<void> {
  const auth = Buffer.from(`${adminUser}:${adminPassword}`).toString('base64');
  const response = await fetch(new URL(path, required('REDEMEINE_RABBIT_MANAGEMENT_URL')), {
    method, headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok && !(method === 'DELETE' && response.status === 404)) throw new Error(`admin HTTP ${response.status}`);
}

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
  await new Promise<void>((resolve, reject) => {
    channel.publish(exchange, '', Buffer.from(JSON.stringify(commit)), { mandatory: true, persistent: true,
      contentType: 'application/json', messageId: commit.id,
      headers: { collection, partitionId: commit.partitionId, streamId: commit.streamId } },
    (error) => error ? reject(error) : resolve());
  });
}

function makeCommit(partitionId: string, amount: number): ICommit {
  return { id: 'crash-source-commit', partitionId, streamId: 'crash-source-stream', commitSequence: 0,
    createDateTime: '2026-01-01T00:00:00.000Z',
    events: [{ ...sourceEvent('crash-event', 'real.order-placed.v1.event', { orderId: 'crash-order', amount }), version: 0 }] };
}

async function physical(client: MongoClient, dbName: string, sagaPartition: string, sagaId: string): Promise<unknown[]> {
  return client.db(dbName).collection(`tw_${sagaPartition}_commits`).find({ streamId: sagaId }).toArray();
}

async function setup(): Promise<{ env: NodeJS.ProcessEnv; cleanup(): Promise<void> }> {
  const id = required('REDEMEINE_REAL_RUN_ID');
  const vhost = `crash_${id}`;
  const user = `crash_${id}`;
  const password = randomBytes(24).toString('hex');
  await admin(`/api/vhosts/${encodeURIComponent(vhost)}`, 'PUT');
  try {
    await admin(`/api/users/${encodeURIComponent(user)}`, 'PUT', { password, tags: 'administrator' });
    await admin(`/api/permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(user)}`, 'PUT',
      { configure: '.*', write: '.*', read: '.*' });
  } catch (error) {
    await admin(`/api/vhosts/${encodeURIComponent(vhost)}`, 'DELETE');
    await admin(`/api/users/${encodeURIComponent(user)}`, 'DELETE');
    throw error;
  }
  const url = new URL(required('REDEMEINE_RABBIT_URL'));
  url.username = user;
  url.password = password;
  url.pathname = `/${vhost}`;
  const env = { REDEMEINE_CRASH_VHOST: vhost, REDEMEINE_CRASH_URL: url.toString(),
    REDEMEINE_RABBIT_USER: user, REDEMEINE_RABBIT_PASSWORD: password,
    REDEMEINE_CRASH_DB: `crash_${id}`, REDEMEINE_CRASH_SAGA_PARTITION: `saga_${id}`,
    REDEMEINE_CRASH_PARTITION: `source_${id}`, REDEMEINE_CRASH_COLLECTION: `tw_source_${id}_commits`,
    REDEMEINE_CRASH_EXCHANGE: `source.${id}` };
  return { env, cleanup: async () => {
    const result = await Promise.allSettled([
      admin(`/api/vhosts/${encodeURIComponent(vhost)}`, 'DELETE'),
      admin(`/api/users/${encodeURIComponent(user)}`, 'DELETE')
    ]);
    if (result.some((item) => item.status === 'rejected')) throw new Error('owned Rabbit cleanup incomplete');
  } };
}

type Stack = { readonly client: MongoClient; readonly channel: Channel; readonly pub: ConfirmChannel;
  readonly exchange: string; readonly original: ICommit; readonly sagaId: string };

async function crashPhase(stack: Stack, first: ChildProcess): Promise<unknown[]> {
  const { client, pub, original, sagaId } = stack;
  const dbName = required('REDEMEINE_CRASH_DB');
  const sagaPartition = required('REDEMEINE_CRASH_SAGA_PARTITION');
  await client.db(dbName).collection(required('REDEMEINE_CRASH_COLLECTION')).insertOne(original);
  await awaitSignal(first, (event) => event.kind === 'ready');
  const confirmed = awaitSignal(first, (event) => event.kind === 'confirmed');
  await publish(pub, stack.exchange, original, required('REDEMEINE_CRASH_COLLECTION'));
  expect(await confirmed).toMatchObject({ messageId: original.id, attempt: 1 });
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
  owned: Awaited<ReturnType<typeof setup>>, children: readonly (ChildProcess | undefined)[],
  priorEnv: Record<string, string | undefined>): Promise<void> {
  const cleanup = { ownedChildrenReaped: false, databaseDropped: false, vhostDeleted: false, userDeleted: false };
  try {
    let reaped = true;
    for (const processChild of children) {
      if (processChild && processChild.exitCode === null && processChild.signalCode === null) {
        try { await killOwned(processChild); } catch { reaped = false; }
      }
    }
    cleanup.ownedChildrenReaped = reaped;
    const results = await Promise.allSettled([
      model?.close() ?? Promise.resolve(),
      client.db(required('REDEMEINE_CRASH_DB')).dropDatabase(), owned.cleanup()
    ]);
    cleanup.databaseDropped = results[1]?.status === 'fulfilled' && results[1].value === true;
    cleanup.vhostDeleted = results[2]?.status === 'fulfilled';
    cleanup.userDeleted = cleanup.vhostDeleted;
    await client.close();
    if (!cleanup.ownedChildrenReaped || !cleanup.databaseDropped || !cleanup.vhostDeleted ||
        results[0]?.status !== 'fulfilled') throw new Error('owned crash resources remain after cleanup');
  } finally {
    evidence.cleanup = cleanup;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await writeFile(required('REDEMEINE_CRASH_RECEIPT'), JSON.stringify(evidence), { mode: 0o600 });
  }
}

it('kills the real worker after confirmed retry and before ACK, then reconciles and quarantines changed content', async () => {
  const owned = await setup();
  const client = new MongoClient(required('REDEMEINE_MONGO_URL'));
  let first: ChildProcess | undefined;
  let recovery: ChildProcess | undefined;
  let model: Awaited<ReturnType<typeof connect>> | undefined;
  const priorEnv = Object.fromEntries(Object.keys(owned.env).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, owned.env);
    await client.connect();
    model = await connect(required('REDEMEINE_CRASH_URL'));
    const channel = await model.createChannel();
    const pub = await model.createConfirmChannel();
    const scope = await provision(channel);
    evidence.topology = { vhost: owned.env.REDEMEINE_CRASH_VHOST, input, retryQueue, deadQueue,
      inspected: Boolean(await scope.retry!.inspect()) };
    const stack: Stack = { client, channel, pub, exchange: scope.sourceExchange,
      original: makeCommit(required('REDEMEINE_CRASH_PARTITION'), 1),
      sagaId: instanceId(createRealTable('crash-proof', createCounters()).definition.sagaKey, 'crash-order') };
    first = child('first', owned.env);
    const committed = await crashPhase(stack, first);
    recovery = child('recovery', owned.env);
    await recoveryPhase(stack, recovery, committed);
    await mismatchPhase(stack, recovery, committed);
    evidence.success = true;
    await pub.close();
    await channel.close();
  } finally {
    await cleanOwned(client, model, owned, [first, recovery], priorEnv);
  }
}, 110_000);
