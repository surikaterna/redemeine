import { describe, expect, it } from '@jest/globals';
import { BSON, MongoClient, ObjectId, UUID } from 'mongodb';
import { openMongoSagaTurnRepository } from '../src/TapewormSagaTurnRepository';

const uri = process.env.REDEMEINE_MONGO_URL;
const intentType = 'saga.intent_recorded.event';
const pageBytes = 12 * 1024 * 1024;

function stages(plan: unknown): string[] {
  const found: string[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'stage' && typeof child === 'string') found.push(child);
      else visit(child);
    }
  }
  visit(plan);
  return found;
}

(uri ? describe : describe.skip)('PRECODE ONLY: saga intent source index and delayed insertion', () => {
  it('demonstrates bounded index pages but not static scan fencing', async () => {
    const client = new MongoClient(uri!);
    const db = client.db(`vpwm_precode_${Date.now()}_${process.pid}`);
    const order: string[] = [];
    const receipt: Record<string, unknown> = { head: '865a610a6e6e1ff31291b9a1ec786a3181bafa06', database: db.databaseName };
    try {
      await client.connect();
      receipt.version = (await db.admin().serverInfo()).version;
      receipt.replicaSet = (await db.admin().command({ replSetGetStatus: 1 })).set;
      await openMongoSagaTurnRepository(db, 'sagas');
      const commits = db.collection('tw_sagas_commits');
      await commits.createIndex({ _id: 1 }, { name: 'vpwm_intent_id', partialFilterExpression: { 'events.type': intentType } });
      receipt.indexes = await commits.listIndexes().toArray();
      const uuid = new UUID('00000000-0000-0000-0000-000000000000');
      const make = (id: string, oid: ObjectId, types: string[]) => ({
        _id: oid, token: uuid, isDispatched: false, createDateTime: new Date(),
        id, partitionId: 'sagas', streamId: id, commitSequence: 0,
        sagaTurnIdentity: { sourceTriggerId: id, sagaKey: 'orders', instanceId: id, routeId: 'route' },
        events: types.map((type, index) => ({ id: `${id}:event:${index}`, type, version: index,
          payload: type === intentType ? { schemaVersion: 1, intent: { intentId: `${id}:${index}` } } : {} }))
      });
      const seed = Array.from({ length: 160 }, (_, n) => make(`seed-${n}`, new ObjectId(),
        n % 8 === 0 ? [intentType, intentType, 'saga.business_state_recorded.event'] : ['saga.business_state_recorded.event']));
      await commits.insertMany(seed);
      order.push('seed inserted');
      const filter = { 'events.type': intentType, _id: { $gt: new ObjectId('000000000000000000000000') } };
      const query = () => commits.find(filter).sort({ _id: 1 }).hint('vpwm_intent_id').limit(64).batchSize(1);
      const plan = await query().explain('executionStats');
      receipt.explain = { winningPlan: plan.queryPlanner.winningPlan, executionStats: plan.executionStats,
        stages: stages(plan.queryPlanner.winningPlan) };
      expect(receipt.explain).toEqual(expect.objectContaining({ stages: expect.arrayContaining(['IXSCAN']) }));
      expect(stages(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
      expect(stages(plan.queryPlanner.winningPlan)).not.toContain('SORT');
      const rows = [];
      for await (const row of query()) rows.push(row);
      receipt.sample = { rows: rows.length, bytes: rows.reduce((sum, row) => sum + BSON.calculateObjectSize(row), 0),
        intents: rows.flatMap((row) => (row.events as { type: string }[]).filter((event) => event.type === intentType)).length,
        keysExamined: plan.executionStats.totalKeysExamined, docsExamined: plan.executionStats.totalDocsExamined };
      expect(rows).toHaveLength(20);
      expect((receipt.sample as { bytes: number }).bytes).toBeLessThan(pageBytes);
      expect((receipt.sample as { intents: number }).intents).toBe(40);

      const low = new ObjectId(); // driver-assigned _id exists before insertOne is attempted
      order.push(`A assigned ${low.toHexString()}, paused before insertOne`);
      const anchor = (await db.command({ ping: 1 })).operationTime;
      const stream = commits.watch([], { startAtOperationTime: anchor, maxAwaitTimeMS: 1000 });
      try {
        const high = new ObjectId();
        expect(low.toHexString() < high.toHexString()).toBe(true);
        await commits.insertOne(make('B', high, [intentType]));
        order.push(`B inserted ${high.toHexString()}`);
        const passed = await commits.find({ 'events.type': intentType, _id: { $gt: new ObjectId('000000000000000000000000') } })
          .sort({ _id: 1 }).hint('vpwm_intent_id').batchSize(1);
        let last: ObjectId | undefined;
        let count = 0;
        let bytes = 0;
        try {
          for await (const row of passed) {
            const size = BSON.calculateObjectSize(row);
            expect(size).toBeLessThanOrEqual(pageBytes);
            if (count === 64 || bytes + size > pageBytes) break;
            bytes += size;
            count++;
            last = row._id as ObjectId;
            if (last.equals(high)) break;
          }
        } finally { await passed.close(); }
        expect(last?.equals(high)).toBe(true);
        order.push(`scan passed B; rows=${count}, bytes=${bytes}`);
        const inserted = await commits.insertOne(make('A', low, [intentType]));
        order.push(`A insertOne acknowledged ${inserted.acknowledged}`);
        const future = [];
        for await (const row of commits.find({ 'events.type': intentType, _id: { $gt: high } })
          .sort({ _id: 1 }).hint('vpwm_intent_id').limit(64).batchSize(1)) future.push(row);
        order.push(`future keyset rows=${future.length}`);
        const seen = new Set<string>();
        for (let n = 0; n < 4 && !seen.has('A'); n++) {
          const change = await stream.tryNext();
          if (change?.operationType === 'insert') seen.add(change.fullDocument.id as string);
        }
        order.push(`anchored change stream inserts=${[...seen].join(',')}`);
        receipt.race = { low: low.toHexString(), high: high.toHexString(), scannedRows: count, scannedBytes: bytes,
          inserted: inserted.acknowledged, futureIds: future.map((row) => row.id), streamIds: [...seen] };
        expect(inserted.acknowledged).toBe(true);
        expect(future.some((row) => row.id === 'A')).toBe(false);
        expect(seen.has('A')).toBe(true);
      } finally { await stream.close(); }
      receipt.result = 'NO_GO_STATIC_SCAN';
    } finally {
      receipt.order = order;
      try {
        await db.dropDatabase();
        receipt.cleanup = { dropped: db.databaseName,
          absent: !(await db.admin().listDatabases({ nameOnly: true })).databases.some((entry) => entry.name === db.databaseName) };
      } finally {
        await client.close();
        console.info(`VPWM_PRECODE_RECEIPT=${JSON.stringify(receipt)}`);
      }
    }
  }, 60_000);
});
