import type { CommitProjectionSourceCommitRequest, ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import {
  MongoProjectionStore,
  type ProjectionDedupeRecord,
  type ProjectionDocumentRecord,
  type ProjectionLinkRecord
} from '@redemeine/projection-runtime-store-mongodb';
import { BSON, type Collection, type Db, MongoClient } from 'mongodb';
import { InMemoryProjectionStore } from '../../projection-runtime-store-inmemory/src/index';
import { runCoverageCase } from './sourceProgressCoverageBenchmark';
import { writeBenchmarkEvidence } from './sourceProgressBenchmarkEvidence';
import { inlineProgress, request, sourceUuid } from './sourceProgressBenchmarkRequests';
import { MemoryObserver, MongoOperationObserver, summarizeLatency, timed } from './sourceProgressBenchmarkSupport';
import type { BenchmarkParameters, BenchmarkResult, OperationCounts } from './sourceProgressBenchmarkTypes';
import { runOwnCardinalityCases } from './sourceProgressOwnRecordBenchmark';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const parseList = (value: string, name: string): number[] => {
  const values = value.split(',').map(Number);
  if (values.length === 0 || values.some((entry) => !Number.isSafeInteger(entry) || entry < 1)) {
    throw new Error(`${name} must be a comma-separated list of positive integers.`);
  }
  return values;
};

const option = (name: string, fallback: string): string => {
  const exact = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

const parameters = (): BenchmarkParameters => ({
  eventsPerCommit: parseList(option('--events-per-commit', '1,10,100'), '--events-per-commit'),
  inlineSourceCounts: parseList(option('--inline-source-counts', '1000,1001'), '--inline-source-counts'),
  ownRecordSourceCardinalities: parseList(option('--own-record-source-cardinalities', '10000,100000'), '--own-record-source-cardinalities'),
  samples: parseList(option('--samples', '30'), '--samples')[0] as number,
  seedBatchSize: parseList(option('--seed-batch-size', '1000'), '--seed-batch-size')[0] as number
});

const assertCommitted = (status: string): void => {
  if (status !== 'committed') throw new Error(`Benchmark commit returned ${status}.`);
};

interface MeasuredRun {
  latencies: number[];
  memory: MemoryObserver;
}

const measureRequests = async (
  store: ProjectionSourceCommitStorePort<{ sequence: number }>,
  requests: readonly CommitProjectionSourceCommitRequest<{ sequence: number }>[]
): Promise<MeasuredRun> => {
  const memory = new MemoryObserver();
  const latencies: number[] = [];
  for (const item of requests) {
    latencies.push(await timed(async () => assertCommitted((await store.commitProjectionSourceCommit(item)).status)));
    memory.sample();
  }
  return { latencies, memory };
};

const result = (
  adapter: BenchmarkResult['adapter'],
  scenario: string,
  values: MeasuredRun,
  details: Omit<BenchmarkResult, 'adapter' | 'scenario' | 'latency' | 'memory'>
): BenchmarkResult => ({
  adapter,
  scenario,
  latency: summarizeLatency(values.latencies),
  memory: values.memory.summary(),
  ...details
});

const eventRequests = (eventCount: number, samples: number, name: string) =>
  Array.from({ length: samples }, (_, sequence) => {
    const sourceId = sourceUuid(700_000 + eventCount);
    return request(name, sourceId, sequence, eventCount, `${name}-target`, sequence === 0 ? null : sequence, {
      strategy: 'own_record',
      source: { sourceId, expectedSequence: sequence === 0 ? null : sequence - 1, finalSequence: sequence }
    });
  });

const inlineRequests = (count: number, samples: number, name: string) => {
  const progress = inlineProgress(count);
  return {
    progress,
    requests: Array.from({ length: samples }, (_, index) =>
      request(name, sourceUuid(710_000 + index), 0, 1, `${name}-${index}`, null, {
        strategy: 'in_document',
        targets: [{ targetDocumentId: `${name}-${index}`, expected: {}, final: progress }],
        warnings: { warnAtSourceCount: 1000 }
      })
    )
  };
};

interface AdapterCaseOptions {
  adapter: BenchmarkResult['adapter'];
  createStore(warnings: { count: number }): Promise<ProjectionSourceCommitStorePort<{ sequence: number }>>;
  config: BenchmarkParameters;
  operationCounts(): OperationCounts | 'not_applicable';
  resetOperations(): void;
}

const runEventCases = async (options: AdapterCaseOptions): Promise<BenchmarkResult[]> => {
  const results: BenchmarkResult[] = [];
  for (const eventCount of options.config.eventsPerCommit) {
    const warnings = { count: 0 };
    const store = await options.createStore(warnings);
    options.resetOperations();
    const measured = await measureRequests(store, eventRequests(eventCount, options.config.samples, `${options.adapter}-events-${eventCount}`));
    results.push(
      result(options.adapter, 'events_per_commit', measured, {
        parameters: { eventCount },
        bsonBytes: 0,
        databaseOperations: options.operationCounts(),
        logicalOperations: options.config.samples,
        fenceOperations: options.config.samples,
        coverageOperations: 0,
        warnings: warnings.count
      })
    );
  }
  return results;
};

const runInlineCases = async (options: AdapterCaseOptions): Promise<BenchmarkResult[]> => {
  const results: BenchmarkResult[] = [];
  for (const sourceCount of options.config.inlineSourceCounts) {
    const warnings = { count: 0 };
    const store = await options.createStore(warnings);
    const scenario = inlineRequests(sourceCount, options.config.samples, `${options.adapter}-inline-${sourceCount}`);
    options.resetOperations();
    const measured = await measureRequests(store, scenario.requests);
    results.push(
      result(options.adapter, 'inline_source_count', measured, {
        parameters: { sourceCount },
        bsonBytes: BSON.calculateObjectSize({ sourceProgress: scenario.progress }),
        databaseOperations: options.operationCounts(),
        logicalOperations: options.config.samples,
        fenceOperations: options.config.samples,
        coverageOperations: 0,
        warnings: warnings.count
      })
    );
  }
  return results;
};

const runNoneCase = async (options: AdapterCaseOptions): Promise<BenchmarkResult> => {
  const store = await options.createStore({ count: 0 });
  const none = Array.from({ length: options.config.samples }, (_, index) =>
    request(`${options.adapter}-none`, sourceUuid(720_000 + index), 0, 1, null, null, { strategy: 'none' })
  );
  options.resetOperations();
  const measured = await measureRequests(store, none);
  const operations = options.operationCounts();
  if (operations !== 'not_applicable' && Object.values(operations).some((count) => count !== 0)) {
    throw new Error(`none unexpectedly performed database operations: ${JSON.stringify(operations)}`);
  }
  return result(options.adapter, 'none_operations', measured, {
    parameters: {},
    bsonBytes: 0,
    databaseOperations: operations,
    logicalOperations: options.config.samples,
    fenceOperations: 0,
    coverageOperations: 0,
    warnings: 0
  });
};

const runAdapterCases = async (options: AdapterCaseOptions): Promise<BenchmarkResult[]> => {
  const events = await runEventCases(options);
  const inline = await runInlineCases(options);
  const none = await runNoneCase(options);
  return [...events, ...inline, none];
};

interface BenchmarkContext {
  client: MongoClient;
  databaseName: string;
  db: Db;
  documents: Collection<ProjectionDocumentRecord<{ sequence: number }>>;
  links: Collection<ProjectionLinkRecord>;
  dedupe: Collection<ProjectionDedupeRecord>;
  observer: MongoOperationObserver;
  mongoStore: MongoProjectionStore<{ sequence: number }>;
}

const createContext = async (): Promise<BenchmarkContext> => {
  const client = new MongoClient(required('REDEMEINE_MONGO_URI'), { monitorCommands: true });
  const databaseName = `redemeine_projection_benchmark_${Date.now()}`;
  const observer = new MongoOperationObserver();
  client.on('commandStarted', observer.observe);
  await client.connect();
  const db = client.db(databaseName);
  const documents = db.collection<ProjectionDocumentRecord<{ sequence: number }>>('documents');
  const links = db.collection<ProjectionLinkRecord>('links');
  const dedupe = db.collection<ProjectionDedupeRecord>('dedupe');
  const mongoStore = new MongoProjectionStore({
    collection: documents,
    linkCollection: links,
    dedupeCollection: dedupe,
    mongoClient: client,
    onDedupeWarning: () => undefined
  });
  await mongoStore.initializeProjectionSourceCommitStore();
  return { client, databaseName, db, documents, links, dedupe, observer, mongoStore };
};

const runAllCases = async (context: BenchmarkContext, config: BenchmarkParameters): Promise<BenchmarkResult[]> => {
  const inMemory = await runAdapterCases({
    adapter: 'in_memory',
    createStore: async (warnings) =>
      new InMemoryProjectionStore({
        onDedupeWarning: () => {
          warnings.count += 1;
        }
      }),
    config,
    operationCounts: () => 'not_applicable',
    resetOperations: () => undefined
  });
  const mongo = await runAdapterCases({
    adapter: 'mongodb',
    createStore: async (warnings) => {
      const store = new MongoProjectionStore({
        collection: context.documents,
        linkCollection: context.links,
        dedupeCollection: context.dedupe,
        mongoClient: context.client,
        onDedupeWarning: () => {
          warnings.count += 1;
        }
      });
      await store.initializeProjectionSourceCommitStore();
      return store;
    },
    config,
    operationCounts: () => context.observer.snapshot(),
    resetOperations: () => context.observer.reset()
  });
  const own = await runOwnCardinalityCases(context.mongoStore, context.db, context.observer, config);
  const coverage = await runCoverageCase(context.client, context.db, context.observer, config.samples);
  return [...inMemory, ...mongo, ...own, coverage];
};

const run = async (): Promise<void> => {
  const config = parameters();
  if (config.samples < 20) throw new Error('--samples must be at least 20 for percentile reporting.');
  const context = await createContext();
  const results = await runAllCases(context, config);
  const server = await context.db.admin().command({ buildInfo: 1 });
  await context.db.dropDatabase();
  await context.client.close();
  await writeBenchmarkEvidence(config, results, String(server.version));
};

await run();
