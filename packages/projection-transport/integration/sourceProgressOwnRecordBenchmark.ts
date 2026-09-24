import type { MongoProjectionStore } from '@redemeine/projection-runtime-store-mongodb';
import { BSON, type Collection, type Db, type Document } from 'mongodb';
import { request, sourceUuid } from './sourceProgressBenchmarkRequests';
import { MemoryObserver, type MongoOperationObserver, summarizeLatency, timed } from './sourceProgressBenchmarkSupport';
import type { BenchmarkParameters, BenchmarkResult } from './sourceProgressBenchmarkTypes';

interface OwnProgressRecord extends Document {
  _id: string;
  updatedAt: string;
  projectionName: string;
  projectionGeneration: string;
  sourceId: string;
  commitSequence: number;
}

const seedOwnRecords = async (
  collection: Collection<OwnProgressRecord>,
  name: string,
  cardinality: number,
  batchSize: number
): Promise<{ durationMs: number; batches: number; bsonBytesPerRecord: number }> => {
  const started = process.hrtime.bigint();
  let batches = 0;
  for (let offset = 0; offset < cardinality; offset += batchSize) {
    const size = Math.min(batchSize, cardinality - offset);
    const records = Array.from({ length: size }, (_, index) => {
      const sourceId = sourceUuid(offset + index + 1);
      return {
        _id: `${name}\u0000v1\u0000${sourceId}`,
        updatedAt: '2026-09-22T00:00:00.000Z',
        projectionName: name,
        projectionGeneration: 'v1',
        sourceId,
        commitSequence: 0
      };
    });
    await collection.insertMany(records, { ordered: true });
    batches += 1;
  }
  const sample = {
    _id: `${name}\u0000v1\u0000${sourceUuid(1)}`,
    updatedAt: '2026-09-22T00:00:00.000Z',
    projectionName: name,
    projectionGeneration: 'v1',
    sourceId: sourceUuid(1),
    commitSequence: 0
  };
  return { durationMs: Number(process.hrtime.bigint() - started) / 1_000_000, batches, bsonBytesPerRecord: BSON.calculateObjectSize(sample) };
};

const measureOwn = async (store: MongoProjectionStore<{ sequence: number }>, name: string, samples: number) => {
  const memory = new MemoryObserver();
  const latencies: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const sourceId = sourceUuid(index + 1);
    const item = request(name, sourceId, 1, 1, null, null, {
      strategy: 'own_record',
      source: { sourceId, expectedSequence: 0, finalSequence: 1 }
    });
    latencies.push(
      await timed(async () => {
        const outcome = await store.commitProjectionSourceCommit(item);
        if (outcome.status !== 'committed') throw new Error(`Own-record benchmark returned ${outcome.status}.`);
      })
    );
    memory.sample();
  }
  return { latency: summarizeLatency(latencies), memory: memory.summary() };
};

export const runOwnCardinalityCases = async (
  store: MongoProjectionStore<{ sequence: number }>,
  db: Db,
  observer: MongoOperationObserver,
  config: BenchmarkParameters
): Promise<Array<BenchmarkResult & { setup: Record<string, number> }>> => {
  const results: Array<BenchmarkResult & { setup: Record<string, number> }> = [];
  const dedupe = db.collection<OwnProgressRecord>('dedupe');
  for (const cardinality of config.ownRecordSourceCardinalities) {
    const name = `mongodb-own-${cardinality}`;
    observer.reset();
    const setup = await seedOwnRecords(dedupe, name, cardinality, config.seedBatchSize);
    const setupOperations = observer.snapshot();
    observer.reset();
    const measured = await measureOwn(store, name, config.samples);
    results.push({
      adapter: 'mongodb',
      scenario: 'own_record_source_cardinality',
      parameters: { cardinality },
      ...measured,
      bsonBytes: setup.bsonBytesPerRecord,
      databaseOperations: observer.snapshot(),
      logicalOperations: config.samples,
      fenceOperations: 0,
      coverageOperations: 0,
      warnings: 0,
      setup: {
        seedDurationMs: Number(setup.durationMs.toFixed(3)),
        seedBatchSize: config.seedBatchSize,
        seedBatches: setup.batches,
        databaseReads: setupOperations.reads,
        databaseWrites: setupOperations.writes,
        databaseIndexOperations: setupOperations.indexOperations,
        databaseTransactions: setupOperations.transactions
      }
    });
  }
  return results;
};
