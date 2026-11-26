import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProjectionDispatchBindingProof } from '@redemeine/projection-runtime-core';
import type { CommandStartedEvent, Db, MongoClient } from 'mongodb';
import { approvalDigest, joinedMembershipSeedRow, type ApprovedJoinedSetInventory } from '../src';
import { coordinator, orderId, path, snapshot, turn } from './joinMembershipFixture';
import { seedCutover } from './realJoinMembershipCutover';
import { completed } from './joinMembershipScenarios';

export async function runSetCollationCutover(db: Db, client: MongoClient, commands: CommandStartedEvent[],
  collated: 'views' | 'memberships' | 'neither') {
  const source = randomUUID();
  const collation = { locale: 'en', strength: 2 };
  const { scope, registry, collection, joinedApprovals, members, docs, store, fixture, makeTransport, transport } =
    await seedCutover(db, client, source, collated === 'neither' ? {} : { [collated]: collation });
  const { queueId, manifestId, registryGeneration } = registry;
  const seed = { ...path, targetDocumentIds: ['A'] };
  await members.insertOne(joinedMembershipSeedRow(scope, seed));
  await docs.insertOne({ _id: 'a', state: { id: 'a', visits: [] } });
  const inventory: ApprovedJoinedSetInventory = { ...scope, format: 'set-v1', linkNamespace: members.namespace,
    documentNamespace: docs.namespace, expectedSets: [seed], maxLinkRows: 1, maxEdges: 1, maxTargetBytes: 2048 };
  const approval = { _id: `joined_approval:${queueId}`, kind: 'joined_approval' as const, queueBindingId: queueId,
    manifestId, registryGeneration, approvalNamespace: joinedApprovals.namespace, transportNamespace: collection.namespace,
    approvedBy: 'operator', approvedAt: new Date().toISOString(), inventories: [inventory] };
  await joinedApprovals.insertOne({ ...approval, digest: approvalDigest(approval) });
  const original = turn(source, 1, orderId, [['ordinary']]);
  const proof = createProjectionDispatchBindingProof(registry);
  const admit = () => transport.admitForDispatch(original, queueId, proof);
  await assert.rejects(admit, collated === 'neither' ? /missing or tombstoned/ : /requires simple collation/);
  assert.equal(await collection.countDocuments({ kind: { $in: ['joined_adoption', 'coverage'] } }), 0);
  assert.equal((await snapshot(store, source, ['A'])).targets[0]?.state, null);
  if (collated !== 'neither') {
    console.log(JSON.stringify({ scenario: 'set-resource-collation-rejected', collated, adoptionRows: 0, coverageRows: 0 }));
    return;
  }

  await docs.insertOne({ _id: 'A', state: { id: 'A', visits: [] } });
  await admit();
  const restarted = makeTransport();
  const runtime = coordinator({ ...fixture, queueBindingId: queueId, manifest: registry, sourceOrder: restarted });
  commands.length = 0;
  await completed(runtime, original);
  assert.equal(commands.filter(({ databaseName, commandName }) => databaseName === db.databaseName && commandName === 'listCollections').length, 2);
  for (const name of ['views', 'memberships']) {
    const reads = commands.filter(({ databaseName, command }) => databaseName === db.databaseName && command.find === name);
    const writes = commands.filter(({ databaseName, command }) => databaseName === db.databaseName && command.update === name);
    assert(reads.length && writes.length);
    assert(reads.every(({ command }) => command.collation?.locale === 'simple'));
    assert(writes.every(({ command }) => command.updates.every((op: { collation?: { locale?: string } }) => op.collation?.locale === 'simple')));
  }
  commands.length = 0;
  await restarted.admitForDispatch(original, queueId, proof);
  assert.equal(commands.filter(({ commandName }) => commandName === 'listCollections').length, 0);
  const result = await snapshot(store, source, ['A', 'a']);
  assert.deepEqual(result.targets.map(({ state }) => state?.visits), [['ordinary'], []]);
  assert.equal(await restarted.loadCoveredThrough(queueId, source), 1);
  console.log(JSON.stringify({ scenario: 'set-resource-collation', exactCaseOnly: true, metadataReadsAtRestart: 2, warmMetadataReads: 0 }));
}
