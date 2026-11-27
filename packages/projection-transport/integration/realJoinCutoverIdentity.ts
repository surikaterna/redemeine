import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BSON, type CommandStartedEvent, type CommandSucceededEvent, type Db, type MongoClient } from 'mongodb';
import { createProjectionDispatchBindingProof } from '@redemeine/projection-runtime-core';
import { approvalDigest, joinedMembershipSeedRow, type ApprovedJoinedSetInventory, type JoinedApproval } from '../src';
import { orderId, path, turn } from './joinMembershipFixture';
import { joinBindingConfiguration, seedJoinBinding } from './realJoinBinding';
import { seedCutover } from './realJoinMembershipCutover';

export function observeReads(client: MongoClient, db: Db, collections: readonly string[]) {
  const pending = new Map<number, string>();
  const counts = new Map<string, { commands: number; docs: number; bsonBytes: number }>();
  const started = ({ databaseName, command, requestId }: CommandStartedEvent) => {
    const name: unknown = command.find ?? command.collection;
    if (databaseName === db.databaseName && typeof name === 'string' && collections.includes(name)) pending.set(requestId, name);
  };
  const succeeded = ({ reply, requestId }: CommandSucceededEvent) => {
    const name = pending.get(requestId);
    if (!name) return;
    pending.delete(requestId);
    const { cursor } = reply as { cursor?: { firstBatch?: BSON.Document[]; nextBatch?: BSON.Document[] } };
    const batch = cursor?.firstBatch ?? cursor?.nextBatch ?? [];
    const stats = counts.get(name) ?? { commands: 0, docs: 0, bsonBytes: 0 };
    stats.commands += 1;
    stats.docs += batch.length;
    for (const row of batch) stats.bsonBytes += BSON.calculateObjectSize(row);
    counts.set(name, stats);
  };
  client.on('commandStarted', started);
  client.on('commandSucceeded', succeeded);
  return { measure: async (work: () => Promise<unknown>) => {
    counts.clear();
    pending.clear();
    await work();
    return Object.fromEntries([...counts].map(([name, stats]) => [name, { ...stats }]));
  }, close() {
    client.off('commandStarted', started);
    client.off('commandSucceeded', succeeded);
  } };
}

function largeInventory(setup: Awaited<ReturnType<typeof seedCutover>>) {
  const targetDocumentIds = Array.from({ length: 960 }, (_, index) => String(index).padStart(4, '0').padEnd(980, 'x'));
  const expectedSets = Array.from({ length: 16 }, (_, index) => ({ ...path, aggregateId: `order-${index}`, targetDocumentIds }));
  const inventory: ApprovedJoinedSetInventory = { ...setup.scope, format: 'set-v1', linkNamespace: setup.members.namespace,
    documentNamespace: setup.docs.namespace, maxLinkRows: expectedSets.length, maxEdges: expectedSets.length * targetDocumentIds.length,
    maxTargetBytes: 32 * 1024 * 1024, expectedSets };
  const { queueId, manifestId, registryGeneration } = setup.registry;
  const template = { _id: `joined_approval:${queueId}`, kind: 'joined_approval' as const, queueBindingId: queueId, manifestId,
    registryGeneration, approvalNamespace: setup.joinedApprovals.namespace, transportNamespace: setup.collection.namespace,
    approvedBy: 'integration-operator', approvedAt: new Date().toISOString(), inventories: [inventory] };
  const approval: JoinedApproval = { ...template, digest: approvalDigest(template) };
  return { targetDocumentIds, inventory, approval };
}

async function checkApprovalBsonLimit(db: Db, approval: JoinedApproval, inventory: ApprovedJoinedSetInventory) {
  const body = { ...approval, inventories: [{ ...inventory, maxLinkRows: 18, maxEdges: 18 * 960,
    expectedSets: [...inventory.expectedSets, ...inventory.expectedSets.slice(0, 2).map((row) =>
      ({ ...row, aggregateId: `${row.aggregateId}-extra` }))] }] };
  const oversized = { ...body, digest: approvalDigest(body) };
  const oversizedBsonBytes = BSON.calculateObjectSize(oversized);
  assert(oversizedBsonBytes > 16 * 1024 * 1024);
  await assert.rejects(db.collection<JoinedApproval>('oversized').insertOne(oversized), /BSON|document.*(size|large)/i);
  assert.equal(await db.collection('oversized').countDocuments(), 0);
  return oversizedBsonBytes;
}

async function assertRejectsChangedIdentity(setup: Awaited<ReturnType<typeof seedCutover>>, db: Db, source: string, approval: JoinedApproval) {
  const check = () => setup.makeTransport().verifyJoinedCutover(setup.registry.queueId, source);
  await setup.joinedApprovals.updateOne({ _id: approval._id }, { $set: { digest: `sha256:${'a'.repeat(64)}` } });
  await assert.rejects(check, /approval identity/);
  await setup.joinedApprovals.updateOne({ _id: approval._id }, { $set: { digest: approval.digest } });
  await assert.rejects(() => setup.makeTransport(db.collection('wrong')).verifyJoinedCutover(setup.registry.queueId, source), /approval identity/);
  const adoption = `joined_adoption:${setup.registry.queueId}`;
  await setup.collection.updateOne({ _id: adoption }, { $set: { registryGeneration: 'wrong' } });
  await assert.rejects(check, /adoption conflict/);
  await setup.collection.updateOne({ _id: adoption }, { $set: { registryGeneration: setup.registry.registryGeneration } });
  await check();
}

export async function runLargeCutoverIdentity(db: Db, client: MongoClient) {
  const source = randomUUID();
  const setup = await seedCutover(db, client, source);
  const { registry, transport, makeTransport, members, docs, joinedApprovals } = setup;
  const { approval, inventory, targetDocumentIds } = largeInventory(setup);
  const approvalBsonBytes = BSON.calculateObjectSize(approval);
  assert(approvalBsonBytes > 14 * 1024 * 1024 && approvalBsonBytes < 16 * 1024 * 1024);
  const oversizedBsonBytes = await checkApprovalBsonLimit(db, approval, inventory);
  await joinedApprovals.insertOne(approval);
  await docs.insertMany(targetDocumentIds.map((_id) => ({ _id, state: null })));
  await members.insertMany(inventory.expectedSets.map((row) => joinedMembershipSeedRow(setup.scope, row)));
  const input = turn(source, 1, orderId, [['ordinary']]);
  const proof = createProjectionDispatchBindingProof(registry);
  const admit = (store = transport) => store.admitForDispatch(input, registry.queueId, proof);
  const monitor = observeReads(client, db, ['approvals', 'memberships', 'views']);
  try {
    const first = await monitor.measure(admit);
    assert.deepEqual(first.approvals, { commands: 2, docs: 2, bsonBytes: approvalBsonBytes * 2 });
    assert(first.memberships?.docs === inventory.expectedSets.length);
    const steady = await monitor.measure(admit);
    assert.deepEqual(Object.keys(steady), ['approvals']);
    assert.equal(steady.approvals?.commands, 1);
    assert(steady.approvals.bsonBytes < 1024);
    // A live revision cannot satisfy the seed verifier; restart must use its durable adoption.
    await members.updateOne({}, { $set: { revision: 1 } });
    const restart = await monitor.measure(() => admit(makeTransport()));
    assert.deepEqual(restart, steady);
    await assertRejectsChangedIdentity(setup, db, source, approval);
    console.log(JSON.stringify({ scenario: 'large-cutover-identity', approvalBsonBytes, oversizedBsonBytes, first, steady, restart }));
  } finally {
    monitor.close();
  }
}

export async function runCutoverTargetPresence(db: Db, client: MongoClient, set: boolean) {
  const source = randomUUID();
  const { manifest } = joinBindingConfiguration(set, true, source);
  const { docs, sourceOrder, collection } = await seedJoinBinding(db, client, set, manifest, source, false, true);
  const verify = () => sourceOrder.verifyJoinedCutover(manifest.queueId, source);
  const adoption = () => collection.findOne({ _id: `joined_adoption:${manifest.queueId}` });
  await docs.updateOne({ _id: 'A' }, { $unset: { state: '' } });
  await assert.rejects(verify, /target document missing or tombstoned/);
  for (const marker of ['deleted', 'tombstone']) {
    await docs.updateOne({ _id: 'A' }, { $set: { state: null, [marker]: true } });
    await assert.rejects(verify, /target document missing or tombstoned/);
    await docs.updateOne({ _id: 'A' }, { $unset: { [marker]: '' } });
  }
  assert.equal(await adoption(), null);
  const bodyBytes = 4 * 1024 * 1024;
  await docs.updateOne({ _id: 'B' }, { $set: { state: { body: 'x'.repeat(bodyBytes) } } });
  const monitor = observeReads(client, db, ['views']);
  try {
    const reads = await monitor.measure(verify);
    assert(await adoption());
    assert.equal(reads.views?.docs, set ? 2 : 1);
    assert(reads.views.bsonBytes < 128);
    console.log(JSON.stringify({ scenario: 'cutover-target-presence', set, referencedLargeBodyBytes: set ? bodyBytes : 0, reads }));
  } finally {
    monitor.close();
  }
}
