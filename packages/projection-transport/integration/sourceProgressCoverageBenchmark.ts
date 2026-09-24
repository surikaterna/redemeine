import type { ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import { BSON, type Db, type MongoClient } from 'mongodb';
import type { ICommit } from 'tapeworm';
import { createTapewormMongoCompleteCommitRangeReader, MongoProjectionTransportStore,
  type AcceptedBaseline, type ProjectionTransportDocument } from '../src';
import { SOURCE_ID, stackManifest } from './realStackFixtures';
import { request } from './sourceProgressBenchmarkRequests';
import { MemoryObserver, type MongoOperationObserver, summarizeLatency, timed } from './sourceProgressBenchmarkSupport';
import type { BenchmarkResult, OperationCounts } from './sourceProgressBenchmarkTypes';

const QUEUE = 'benchmark-coverage';

export function benchmarkCoverageBaseline(): AcceptedBaseline {
  const manifest = stackManifest(QUEUE);
  const at = new Date().toISOString();
  return { version: 2, kind: 'existing', queueBindingId: QUEUE, manifestId: manifest.manifestId,
    registryGeneration: manifest.registryGeneration, sourceId: SOURCE_ID, lastAcceptedSequence: -1,
    startAnchor: 0, operator: 'benchmark-operator-accepts-empty-fixture', acceptedAt: at,
    acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedBy: 'benchmark-isolated-fixture-no-old-writer',
    oldWriterStoppedAt: at, queueTailReadinessReference: 'indexed-empty-benchmark-source',
    strategyScope: manifest.definitions.map(({ projectionName, generation }) => ({ projectionName, generation,
      strategy: projectionName === 'N-none' ? 'none' : projectionName === 'Q-inline' ? 'in_document' : 'own_record',
      stableSingleTarget: projectionName === 'Q-inline' })) };
}

export interface CoverageOrderPort {
  installAcceptedBaseline(record: AcceptedBaseline): Promise<void>;
  admitForDispatch(commit: ProjectionSourceCommit, queue: string): Promise<unknown>;
  advanceCoverage(request: { queueBindingId: string; sourceId: string; expectedSequence: number | null; sequence: number }): Promise<unknown>;
}

export async function prepareCoverageAdmission(store: CoverageOrderPort, baseline: AcceptedBaseline): Promise<void> {
  await store.installAcceptedBaseline(baseline);
  const syntheticWakeup = request('coverage', SOURCE_ID, 0, 1, null, null, { strategy: 'none' }).commit;
  await store.admitForDispatch(syntheticWakeup, baseline.queueBindingId);
}

export async function measureCoverageAdvances(store: CoverageOrderPort, samples: number) {
  const memory = new MemoryObserver();
  const latencies: number[] = [];
  let coverageOperations = 0;
  for (let sequence = 0; sequence < samples; sequence += 1) {
    latencies.push(await timed(async () => {
      await store.advanceCoverage({ queueBindingId: QUEUE, sourceId: SOURCE_ID,
        expectedSequence: sequence === 0 ? null : sequence - 1, sequence });
      coverageOperations += 1;
    }));
    memory.sample();
  }
  return { memory: memory.summary(), latency: summarizeLatency(latencies), coverageOperations };
}

export function coverageBenchmarkResult(samples: number, measured: Awaited<ReturnType<typeof measureCoverageAdvances>>,
  operations: OperationCounts, setupOperations: OperationCounts, indexName: string): BenchmarkResult {
  return { adapter: 'mongodb', scenario: 'transport_coverage_synthetic_cas',
    parameters: { coverageBasis: 'standalone_synthetic_order_port_cas', sourceBacked: 'false' },
    ...measured, bsonBytes: BSON.calculateObjectSize({ sourceId: SOURCE_ID, sequence: samples - 1 }),
    databaseOperations: operations, logicalOperations: samples, fenceOperations: samples, warnings: 0,
    setup: { baselineRegistrations: 1, sourceRows: 0, indexedHighWatermark: -1, sourceIndex: indexName,
      databaseReads: setupOperations.reads, databaseWrites: setupOperations.writes,
      databaseIndexOperations: setupOperations.indexOperations, databaseTransactions: setupOperations.transactions } };
}

export async function runCoverageCase(client: MongoClient, db: Db, observer: MongoOperationObserver,
  samples: number): Promise<BenchmarkResult> {
  observer.reset();
  const source = db.collection<ICommit>('tw_benchmark_coverage_commits');
  await source.createIndex({ streamId: 1, commitSequence: 1 }, { unique: true });
  const reader = createTapewormMongoCompleteCommitRangeReader({ collection: source, partitionId: QUEUE });
  await reader.initialize();
  const baseline = benchmarkCoverageBaseline();
  const store = new MongoProjectionTransportStore({ collection: db.collection<ProjectionTransportDocument>('coverage'),
    mongoClient: client, manifest: stackManifest(QUEUE), cutoverReadiness: { reader } });
  await prepareCoverageAdmission(store, baseline);
  const highWatermark = await reader.probeSource(SOURCE_ID, -1);
  if (highWatermark !== -1) throw new Error('Benchmark order-port CAS requires a genuinely empty indexed source.');
  const setupOperations = observer.snapshot();
  observer.reset();
  const measured = await measureCoverageAdvances(store, samples);
  const indexName = reader.getIndexName();
  if (!indexName) throw new Error('Benchmark indexed source readiness was lost.');
  return coverageBenchmarkResult(samples, measured, observer.snapshot(), setupOperations, indexName);
}
