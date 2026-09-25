import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BSON, type Collection, type Db, MongoClient, ObjectId, UUID } from 'mongodb';
import { openMongoSagaTurnRepository } from '../src/TapewormSagaTurnRepository';
import { inspectIntentExplain } from './precode-plan';

const uri = process.env.REDEMEINE_MONGO_URL;
const intentType = 'saga.intent_recorded.event';
const indexName = 'vpwm_type_id';
const maxBytes = 12 * 1024 * 1024;
const firstId = new ObjectId('000000000000000000000000');
type Receipt = Record<string, unknown>;

function makeCommit(id: string, oid: ObjectId, types: string[], blob = '') {
  return {
    _id: oid, token: new UUID('00000000-0000-0000-0000-000000000000'),
    isDispatched: false, createDateTime: new Date(), id, partitionId: 'sagas',
    streamId: id, commitSequence: 0,
    sagaTurnIdentity: { sourceTriggerId: id, sagaKey: 'orders', instanceId: id, routeId: 'route' },
    events: types.map((type, index) => ({ id: `${id}:event:${index}`, type, version: index,
      payload: type === intentType ? { schemaVersion: 1, intent: { intentId: `${id}:${index}`, blob } } : {} }))
  };
}

async function explainPlans(commits: Collection, receipt: Receipt): Promise<void> {
  const filter = { 'events.type': intentType, _id: { $gt: firstId } };
  const base = () => commits.find(filter).sort({ _id: 1 }).limit(64).batchSize(1);
  const plans = { normal: await base().explain('executionStats'), hinted: await base().hint(indexName).explain('executionStats') };
  receipt.plans = Object.fromEntries(Object.entries(plans).map(([name, plan]) => [name, {
    winningPlan: plan.queryPlanner.winningPlan, selected: inspectIntentExplain(plan)
  }]));
}

async function page(commits: Collection, after: ObjectId) {
  const cursor = commits.find({ 'events.type': intentType, _id: { $gt: after } })
    .sort({ _id: 1 }).hint(indexName).limit(64).batchSize(1);
  const ids: string[] = [];
  const intentIds: string[] = [];
  let bytes = 0;
  let last = after;
  try {
    for await (const row of cursor) {
      const size = BSON.calculateObjectSize(row);
      if (size > maxBytes) throw new Error(`Oversized one-row commit ${row.id}: ${size} bytes`);
      if (bytes + size > maxBytes) break;
      bytes += size;
      ids.push(row.id as string);
      for (const event of row.events as { type: string; payload: { intent: { intentId: string } } }[]) {
        if (event.type === intentType) intentIds.push(event.payload.intent.intentId);
      }
      last = row._id as ObjectId;
    }
  } finally { await cursor.close(); }
  expect(ids.length).toBeLessThanOrEqual(64);
  expect(bytes).toBeLessThanOrEqual(maxBytes);
  return { ids, intentIds, bytes, last };
}

async function populate(db: Db, receipt: Receipt): Promise<Collection> {
  await openMongoSagaTurnRepository(db, 'sagas');
  const commits = db.collection('tw_sagas_commits');
  await commits.createIndex({ 'events.type': 1, _id: 1 }, { name: indexName });
  receipt.indexes = await commits.listIndexes().toArray();
  const seed = Array.from({ length: 640 }, (_, n) => makeCommit(`seed-${n}`, new ObjectId(),
    n % 8 === 0 ? [intentType, intentType, 'saga.business_state_recorded.event'] : ['saga.business_state_recorded.event']));
  await commits.insertMany(seed);
  receipt.seed = { total: seed.length, intentCommits: 80, intents: 160 };
  return commits;
}

async function delayedWriter(commits: Collection, receipt: Receipt): Promise<ObjectId> {
  const order: string[] = [];
  receipt.order = order;
  const low = new ObjectId();
  order.push(`A allocated ${low.toHexString()}; held BEFORE insertOne`);
  const high = new ObjectId();
  expect(low.toHexString() < high.toHexString()).toBe(true);
  await commits.insertOne(makeCommit('B', high, [intentType]));
  order.push(`B inserted ${high.toHexString()}`);
  const scanned: string[] = [];
  const intents: string[] = [];
  const pages: { count: number; bytes: number }[] = [];
  let after = firstId;
  let bytes = 0;
  while (!after.equals(high)) {
    const next = await page(commits, after);
    expect(next.ids.length).toBeGreaterThan(0);
    scanned.push(...next.ids);
    intents.push(...next.intentIds);
    pages.push({ count: next.ids.length, bytes: next.bytes });
    bytes += next.bytes;
    after = next.last;
  }
  expect(scanned).toHaveLength(81);
  expect(intents).toHaveLength(161);
  expect(pages.map(({ count }) => count)).toEqual([64, 17]);
  order.push(`scan passed B; commits=${scanned.length}; bytes=${bytes}`);
  const inserted = await commits.insertOne(makeCommit('A', low, [intentType]));
  order.push(`A insertOne acknowledged=${inserted.acknowledged}`);
  const future = await page(commits, high);
  order.push(`subsequent _id>B returns ${future.ids.length} commits`);
  receipt.race = { low: low.toHexString(), high: high.toHexString(), inserted: inserted.acknowledged,
    present: (await commits.findOne({ id: 'A' }))?._id?.equals(low), scanned, intents,
    pages, scannedBytes: bytes, futureIds: future.ids, futureBytes: future.bytes };
  expect(inserted.acknowledged).toBe(true);
  expect((receipt.race as { present: boolean }).present).toBe(true);
  expect(future.ids).not.toContain('A');
  expect(future.ids).toHaveLength(0);
  return high;
}

async function oversizedRow(commits: Collection, after: ObjectId, receipt: Receipt): Promise<void> {
  const row = makeCommit('oversized', new ObjectId(), [intentType], 'x'.repeat(maxBytes));
  const size = BSON.calculateObjectSize(row);
  expect(size).toBeGreaterThan(maxBytes);
  expect(size).toBeLessThan(16 * 1024 * 1024);
  await commits.insertOne(row);
  await expect(page(commits, after)).rejects.toThrow(`Oversized one-row commit ${row.id}`);
  receipt.oversized = { id: row.id, bsonBytes: size, after: after.toHexString(), refused: true };
}

function scriptIdentity(): Receipt {
  const cwd = process.cwd();
  const path = resolve(cwd, cwd.endsWith('saga-runtime-store-tapeworm')
    ? 'integration/precode-intent-discovery.integration.test.ts'
    : 'packages/saga-runtime-store-tapeworm/integration/precode-intent-discovery.integration.test.ts');
  return { codeHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    script: path, scriptSha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

async function cleanup(db: Db, client: MongoClient, receipt: Receipt): Promise<void> {
  let failure: unknown;
  try {
    await db.dropDatabase();
    receipt.cleanup = { dropped: db.databaseName,
      absent: !(await db.admin().listDatabases({ nameOnly: true })).databases.some((entry) => entry.name === db.databaseName) };
    if (!(receipt.cleanup as { absent: boolean }).absent) throw new Error(`Database ${db.databaseName} remains after drop`);
  } catch (error) {
    receipt.cleanup = { error: String(error) };
    failure = error;
  } finally {
    await client.close();
    console.info(`VPWM_PRECODE_RECEIPT=${JSON.stringify(receipt)}`);
  }
  if (failure) throw failure;
}

(uri ? describe : describe.skip)('PRECODE ONLY: indexed intents and delayed insert, no effects', () => {
  it('records compound index explain, bounded pages and static keyset omission', async () => {
    const client = new MongoClient(uri!);
    const db = client.db(process.env.REDEMEINE_PRECODE_DB ?? `vpwm_precode_${Date.now()}_${process.pid}`);
    const receipt: Receipt = { ...scriptIdentity(), database: db.databaseName };
    try {
      await client.connect();
      receipt.version = (await db.admin().serverInfo()).version;
      receipt.replicaSet = (await db.admin().command({ replSetGetStatus: 1 })).set;
      const commits = await populate(db, receipt);
      await explainPlans(commits, receipt);
      const high = await delayedWriter(commits, receipt);
      await oversizedRow(commits, high, receipt);
      receipt.result = 'NO_GO_STATIC_KEYSET_WITH_UNFENCED_INSERT';
    } catch (error) {
      receipt.failure = String(error);
      throw error;
    } finally {
      await cleanup(db, client, receipt);
    }
  }, 60_000);
});
