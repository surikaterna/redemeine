import { performance } from 'node:perf_hooks';
import { MongoProjectionStore } from '../src';
import type { ProjectionStoreRfc6902Operation } from '../src';
import { createPatchPlanTelemetryReport } from '../src';
import type { MongoPatchPlanTelemetryEvent } from '../src';
import {
  createFakeMongoClient,
  createProjectionDedupeCollection,
  createProjectionDocumentCollection,
  createProjectionLinkCollection
} from '../test/mocks';

type BenchCase = {
  name: string;
  iterations: number;
  docFactory: (index: number) => { fullDocument: Record<string, unknown>; patch: ProjectionStoreRfc6902Operation[] };
};

type BenchResult = {
  name: string;
  iterations: number;
  elapsedMs: number;
  avgMsPerWrite: number;
  telemetry: ReturnType<typeof createPatchPlanTelemetryReport>;
};

const runCase = async (benchCase: BenchCase): Promise<BenchResult> => {
  const collection = createProjectionDocumentCollection<Record<string, unknown>>();
  const telemetryEvents: MongoPatchPlanTelemetryEvent[] = [];
  const store = new MongoProjectionStore<Record<string, unknown>>({
    collection,
    linkCollection: createProjectionLinkCollection(),
    dedupeCollection: createProjectionDedupeCollection(),
    mongoClient: createFakeMongoClient(),
    patchPlanTelemetry: (event) => telemetryEvents.push(event)
  });

  const started = performance.now();

  for (let index = 0; index < benchCase.iterations; index += 1) {
    const sample = benchCase.docFactory(index);
    const result = await store.commitAtomicMany({
      mode: 'atomic-all',
      writes: [
        {
          routingKeySource: `${benchCase.name}:${index}`,
          documents: [
            {
              documentId: `${benchCase.name}-doc-${index}`,
              mode: 'patch',
              fullDocument: sample.fullDocument,
              patch: sample.patch,
              checkpoint: { sequence: index + 1 }
            }
          ],
          dedupe: { upserts: [] }
        }
      ]
    });

    if (result.status !== 'committed') {
      throw new Error(`bench case ${benchCase.name} rejected: ${result.reason}`);
    }
  }

  const elapsedMs = Number((performance.now() - started).toFixed(2));

  return {
    name: benchCase.name,
    iterations: benchCase.iterations,
    elapsedMs,
    avgMsPerWrite: Number((elapsedMs / Math.max(1, benchCase.iterations)).toFixed(4)),
    telemetry: createPatchPlanTelemetryReport(telemetryEvents)
  };
};

const benchCases: BenchCase[] = [
  {
    name: 'compiled-object-and-array',
    iterations: 500,
    docFactory: () => ({
      fullDocument: {
        profile: { name: 'Ada', address: { city: 'Gothenburg' } },
        lines: ['a', 'c', 'd']
      },
      patch: [
        { op: 'replace', path: '/profile/address/city', value: 'Gothenburg' },
        { op: 'remove', path: '/lines/0' }
      ]
    })
  },
  {
    name: 'compiled-root-replace',
    iterations: 500,
    docFactory: (index) => ({
      fullDocument: {
        total: index,
        status: 'paid'
      },
      patch: [
        {
          op: 'replace',
          path: '',
          value: {
            total: index,
            status: 'paid'
          }
        }
      ]
    })
  },
  {
    name: 'fallback-unsafe-mixed',
    iterations: 500,
    docFactory: () => ({
      fullDocument: {
        'a.b': 1,
        safe: true
      },
      patch: [
        { op: 'add', path: '/a.b', value: 1 },
        { op: 'replace', path: '/safe', value: true }
      ]
    })
  }
];

const run = async (): Promise<void> => {
  const results: BenchResult[] = [];

  for (const benchCase of benchCases) {
    results.push(await runCase(benchCase));
  }

  console.log('patch planner/store benchmark summary');
  console.table(
    results.map((result) => ({
      case: result.name,
      iterations: result.iterations,
      elapsedMs: result.elapsedMs,
      avgMsPerWrite: result.avgMsPerWrite,
      compiledRate:
        (result.telemetry.modes['compiled-update-document']?.rate ?? 0) +
        (result.telemetry.modes['compiled-update-pipeline']?.rate ?? 0),
      fallbackRate: result.telemetry.modes['fallback-full-document']?.rate ?? 0,
      cacheHitRate: result.telemetry.cache.hitRate
    }))
  );

  console.log('patch planner/store benchmark json summary');
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runtime: {
          bunVersion: process.versions.bun ?? 'unknown',
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch
        },
        results
      },
      null,
      2
    )
  );
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
