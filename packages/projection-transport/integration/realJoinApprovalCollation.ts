import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Collection, CommandStartedEvent, Db, MongoClient } from 'mongodb';
import type { JoinedApproval } from '../src';
import { joinBindingConfiguration, seedJoinBinding } from './realJoinBinding';
import { observeReads } from './realJoinCutoverIdentity';

async function explainApprovalLookup(db: Db, commands: readonly CommandStartedEvent[], id: string, found: boolean) {
  const relevant = commands.filter(({ databaseName, command }) => databaseName === db.databaseName
    && [command.find, command.collection].some((name) => ['approvals', 'members', 'views'].includes(name)));
  assert.equal(relevant.length, 1, 'After adoption there must be only one approval read and no seed or view reads.');
  const { find, filter, projection, collation, readConcern } = relevant[0]!.command;
  assert.equal(find, 'approvals');
  assert.deepEqual(filter, { _id: id });
  assert.equal(collation, undefined, 'The lookup must inherit the collection collation for its _id index.');
  assert.equal(readConcern.level, 'majority');
  const result = await db.command({ explain: { find, filter, projection, limit: 1 }, verbosity: 'executionStats' });
  const { nReturned, totalDocsExamined, totalKeysExamined, executionStages } = result.executionStats;
  assert.equal(nReturned, found ? 1 : 0);
  assert.equal(totalDocsExamined, found ? 1 : 0);
  assert(totalKeysExamined <= 1);
  assert.match(JSON.stringify(executionStages), /IDHACK|IXSCAN/);
  assert.doesNotMatch(JSON.stringify(executionStages), /COLLSCAN/);
  return { nReturned, totalDocsExamined, totalKeysExamined, plan: executionStages.stage };
}

async function assertRejectedFields(approvals: Collection<JoinedApproval>, original: JoinedApproval,
  verify: () => Promise<void>, measure: ReturnType<typeof observeReads>['measure']) {
  const key = { _id: original._id };
  const oversized = 'z'.repeat(1024 * 1024);
  const invalid = [
    ['kind', original.kind.toUpperCase()], ['queueBindingId', original.queueBindingId.toUpperCase()],
    ['manifestId', original.manifestId.toUpperCase()], ['registryGeneration', original.registryGeneration.toUpperCase()],
    ['approvalNamespace', original.approvalNamespace.toUpperCase()], ['transportNamespace', original.transportNamespace.toUpperCase()],
    ['digest', original.digest.toUpperCase()], ['digest', oversized], ['digest', [original.digest]],
    ['inventories.0.projectionName', original.inventories[0]!.projectionName.toUpperCase()],
    ['inventories.0.generation', original.inventories[0]!.generation.toUpperCase()],
    ['inventories.0.linkNamespace', original.inventories[0]!.linkNamespace.toUpperCase()],
    ['inventories.0.documentNamespace', oversized], ['inventories.0.format', ['set-v1']], ['inventories', {}], ['inventories', []]
  ] as const;
  for (const [field, value] of invalid) {
    await approvals.updateOne(key, { $set: { [field]: value } });
    const reads = await measure(() => assert.rejects(verify, /approval identity/));
    assert.deepEqual(Object.keys(reads), ['approvals']);
    assert.equal(reads.approvals?.docs, 1);
    assert(reads.approvals.bsonBytes < 1024, `Unbounded identity payload for ${field}`);
    await approvals.replaceOne(key, original);
  }
  await approvals.updateOne(key, { $unset: { digest: '' } });
  await assert.rejects(verify, /approval identity/);
  await approvals.replaceOne(key, original);
  return invalid.length + 1;
}

async function assertMarkerRequired(setup: Awaited<ReturnType<typeof seedJoinBinding>>, queueId: string, verify: () => Promise<void>) {
  const key = { _id: `joined_adoption:${queueId}` };
  const marker = await setup.collection.findOne(key);
  assert(marker?.kind === 'joined_adoption');
  await setup.links.updateOne({}, { $set: { revision: 1 } });
  await setup.collection.updateOne(key, { $set: { approvalDigest: 'malformed' } });
  await assert.rejects(verify, /adoption conflict/);
  await setup.collection.replaceOne(key, marker);
  await verify();
  await setup.collection.deleteOne(key);
  await assert.rejects(verify, /membership collection differs/);
  assert.equal(await setup.collection.findOne(key), null);
}

export async function runJoinApprovalCollation(db: Db, client: MongoClient, commands: CommandStartedEvent[], insensitive: boolean) {
  const collation = insensitive ? { locale: 'en', strength: 2 } : { locale: 'simple' };
  const approvals = await db.createCollection<JoinedApproval>('approvals', { collation });
  await db.collection<{ _id: string }>('approvals').insertMany(Array.from({ length: 100 }, (_, i) => ({ _id: `unrelated:${i}` })));
  const source = randomUUID();
  const { manifest } = joinBindingConfiguration(true, true, source);
  const setup = await seedJoinBinding(db, client, true, manifest, source);
  const id = `joined_approval:${manifest.queueId}`;
  const key = { _id: id };
  const original = await approvals.findOne(key);
  assert(original);
  const verify = () => setup.sourceOrder.verifyJoinedCutover(manifest.queueId, source);
  const monitor = observeReads(client, db, ['approvals', 'members', 'views']);
  try {
    commands.length = 0;
    const reads = await monitor.measure(verify);
    assert(reads.approvals && reads.approvals.bsonBytes < 1024);
    const exact = await explainApprovalLookup(db, commands, id, true);
    await approvals.deleteOne(key);
    commands.length = 0;
    await assert.rejects(verify, /approval identity/);
    const missing = await explainApprovalLookup(db, commands, id, false);
    await approvals.insertOne({ ...original, _id: id.toUpperCase() });
    commands.length = 0;
    await assert.rejects(verify, /approval identity/);
    const lookalike = await explainApprovalLookup(db, commands, id, insensitive);
    await approvals.deleteOne({ _id: id.toUpperCase() });
    await approvals.insertOne(original);
    const invalidFields = await assertRejectedFields(approvals, original, verify, monitor.measure);
    await assertMarkerRequired(setup, manifest.queueId, verify);
    console.log(JSON.stringify({ scenario: 'approval-index-collation', insensitive, exact, missing, lookalike, reads, invalidFields }));
  } finally {
    monitor.close();
  }
}
