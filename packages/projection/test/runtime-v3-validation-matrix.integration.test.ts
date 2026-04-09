import { describe, expect, test } from '@jest/globals';
import { createProjectionRouter, type ProjectionDefinitionLike, type ProjectionRouterEnvelope } from '../../projection-router-core/src';
import {
  createProjectionWorkerCore,
  type ProjectionWorkerCommit,
  type ProjectionWorkerDecision
} from '../../projection-worker-core/src';
import type { IProjectionStore } from '../../projection-runtime-core/src';
import { InMemoryProjectionStore } from '../../projection-runtime-store-inmemory/src';
import { MongoProjectionStore } from '../../projection-runtime-store-mongodb/src';
import { createMongoRuntimeCoreStore } from '../../projection-runtime-store-mongodb/test/runtimeCoreStoreHarness';
import {
  createProjectionDedupeCollection,
  createProjectionDocumentCollection,
  createProjectionLinkCollection
} from '../../projection-runtime-store-mongodb/test/mocks';

type StoreAdapterName = 'inmemory' | 'mongodb';

type ProjectionState = {
  events: string[];
};

type WorkerStoreAdapter = {
  name: StoreAdapterName;
  store: IProjectionStore<ProjectionState>;
};

const projectionName = 'rt3-13-matrix';

const createInMemoryAdapter = (): WorkerStoreAdapter => ({
  name: 'inmemory',
  store: new InMemoryProjectionStore<ProjectionState>()
});

const createMongoAdapter = (): WorkerStoreAdapter => {
  const { store } = createMongoRuntimeCoreStore<ProjectionState>();
  return {
    name: 'mongodb',
    store
  };
};

const workerStoreAdapters = [createInMemoryAdapter, createMongoAdapter] as const;

const routerDefinition: ProjectionDefinitionLike = {
  projectionName,
  fromAggregateType: 'invoice',
  identity: (envelope) => envelope.sourceId,
  reverseRules: [
    {
      aggregateType: 'customer',
      targetIdentity: () => ['doc-rule', 'doc-fanout-shared']
    }
  ],
  reverseLinkMutations: (envelope) => {
    if (envelope.eventName === 'linked') {
      return [
        {
          op: 'add',
          aggregateType: envelope.sourceStream,
          aggregateId: envelope.sourceId,
          targetId: 'doc-link'
        },
        {
          op: 'add',
          aggregateType: envelope.sourceStream,
          aggregateId: envelope.sourceId,
          targetId: 'doc-fanout-shared'
        }
      ];
    }

    return [];
  }
};

function toEnvelope(
  sourceStream: string,
  sourceId: string,
  eventName: string,
  sequence: number
): ProjectionRouterEnvelope {
  return {
    projectionName,
    sourceStream,
    sourceId,
    eventName,
    payload: { sequence }
  };
}

function toCommit(
  envelope: ProjectionRouterEnvelope,
  routeDecision: Awaited<ReturnType<ReturnType<typeof createProjectionRouter>['route']>>
): ProjectionWorkerCommit {
  return {
    definition: {
      projectionName: envelope.projectionName
    },
    message: {
      envelope,
      routeDecision
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('RT3-13 validation matrix: router + worker + stores', () => {
  for (const createAdapter of workerStoreAdapters) {
    test(`router fanout (reverse + persisted links) with worker-core on ${createAdapter().name}`, async () => {
      const { store } = createAdapter();
      const router = createProjectionRouter();

      await router.route(
        routerDefinition,
        toEnvelope('customer', 'customer-1', 'linked', 1)
      );

      const routed = await router.route(
        routerDefinition,
        toEnvelope('customer', 'customer-1', 'updated', 2)
      );

      expect(routed.targets).toEqual([
        { targetId: 'doc-link', laneKey: `${projectionName}:doc-link` },
        { targetId: 'doc-fanout-shared', laneKey: `${projectionName}:doc-fanout-shared` },
        { targetId: 'doc-rule', laneKey: `${projectionName}:doc-rule` }
      ]);

      const worker = createProjectionWorkerCore({
        stateLoader: async ({ targetId }) => store.load(targetId),
        processor: async (context): Promise<ProjectionWorkerDecision> => {
          const payload = context.commit.message.envelope.payload as { sequence?: number };
          const sequence = payload.sequence ?? 0;

          for (const target of context.commit.message.routeDecision.targets) {
            const current = (await context.getProjectionState(target.targetId)) as ProjectionState | null;
            const nextState: ProjectionState = {
              events: [...(current?.events ?? []), `${context.commit.message.envelope.eventName}:${sequence}`]
            };

            context.setProjectionState(target.targetId, nextState);
            await store.save(target.targetId, nextState, {
              sequence,
              timestamp: `2026-04-09T00:00:${String(sequence).padStart(2, '0')}.000Z`
            });
          }

          return { status: 'ack' };
        }
      });

      await worker.push(toCommit(toEnvelope('customer', 'customer-1', 'updated', 2), routed));

      expect(await store.load('doc-link')).toEqual({ events: ['updated:2'] });
      expect(await store.load('doc-fanout-shared')).toEqual({ events: ['updated:2'] });
      expect(await store.load('doc-rule')).toEqual({ events: ['updated:2'] });
    });
  }

  for (const createAdapter of workerStoreAdapters) {
    test(`lane ordering and batching modes with worker-core on ${createAdapter().name}`, async () => {
      const { store } = createAdapter();

      const orderingWorker = createProjectionWorkerCore({
        stateLoader: async ({ targetId }) => store.load(targetId),
        processor: async (context): Promise<ProjectionWorkerDecision> => {
          const eventName = context.commit.message.envelope.eventName;

          if (eventName === 'first') {
            await delay(15);
          }

          if (eventName === 'second') {
            await delay(5);
          }

          const targetId = context.commit.message.routeDecision.targets[0]?.targetId;
          if (!targetId) {
            return { status: 'nack', retryable: false, reason: 'missing-target' };
          }

          const current = (await context.getProjectionState(targetId)) as ProjectionState | null;
          const nextState: ProjectionState = {
            events: [...(current?.events ?? []), eventName]
          };

          context.setProjectionState(targetId, nextState);
          await store.save(targetId, nextState, { sequence: nextState.events.length });

          return { status: 'ack' };
        }
      });

      const routeDecision = {
        projectionName,
        targets: [{ targetId: 'doc-lane', laneKey: `${projectionName}:doc-lane` }]
      };

      await orderingWorker.pushMany([
        toCommit(toEnvelope('invoice', 'doc-lane', 'first', 1), routeDecision),
        toCommit(toEnvelope('invoice', 'doc-lane', 'second', 2), routeDecision),
        toCommit(toEnvelope('invoice', 'doc-lane', 'third', 3), routeDecision)
      ]);

      expect(await store.load('doc-lane')).toEqual({ events: ['first', 'second', 'third'] });

      const singleBatchShapes: number[] = [];
      const singleWorker = createProjectionWorkerCore({
        processor: () => ({ status: 'ack' }),
        batchProcessor: (context) => {
          singleBatchShapes.push(context.commits.length);
          return context.commits.map(() => ({ status: 'ack' as const }));
        },
        getProjectionConfig: () => ({ microBatching: 'single' })
      });

      await singleWorker.pushMany([
        toCommit(toEnvelope('invoice', 'doc-lane', 'single-a', 4), routeDecision),
        toCommit(toEnvelope('invoice', 'doc-lane', 'single-b', 5), routeDecision),
        toCommit(toEnvelope('invoice', 'doc-lane', 'single-c', 6), routeDecision)
      ]);

      expect(singleBatchShapes).toEqual([1, 1, 1]);

      const allBatchShapes: string[][] = [];
      const allBatchTargets: string[][] = [];
      const allWorker = createProjectionWorkerCore({
        processor: () => ({ status: 'ack' }),
        batchProcessor: (context) => {
          allBatchShapes.push(context.commits.map((commit) => commit.message.envelope.eventName));
          allBatchTargets.push(
            context.commits.map((commit) => commit.message.routeDecision.targets[0]?.targetId ?? 'missing-target')
          );
          return context.commits.map(() => ({ status: 'ack' as const }));
        },
        getProjectionConfig: () => ({ microBatching: 'all' })
      });

      const routeDecisionDoc1 = {
        projectionName,
        targets: [{ targetId: 'doc-lane', laneKey: `${projectionName}:doc-lane` }]
      };

      const routeDecisionDoc2 = {
        projectionName,
        targets: [{ targetId: 'doc-lane-2', laneKey: `${projectionName}:doc-lane-2` }]
      };

      await allWorker.pushMany([
        toCommit(toEnvelope('invoice', 'doc-lane', 'all-a', 7), routeDecisionDoc1),
        toCommit(toEnvelope('invoice', 'doc-lane-2', 'all-b', 8), routeDecisionDoc2),
        toCommit(toEnvelope('invoice', 'doc-lane', 'all-c', 9), routeDecisionDoc1)
      ]);

      expect(allBatchShapes).toEqual([['all-a', 'all-b', 'all-c']]);
      expect(allBatchTargets).toEqual([['doc-lane', 'doc-lane-2', 'doc-lane']]);
    });
  }
});

describe('RT3-13 validation matrix: watermark semantics', () => {
  test('commitAtomicMany highestWatermark and rejection semantics match for inmemory and mongodb', async () => {
    const stores = [
      {
        name: 'inmemory' as const,
        store: new InMemoryProjectionStore<Record<string, unknown>>()
      },
      {
        name: 'mongodb' as const,
        store: new MongoProjectionStore<Record<string, unknown>>({
          collection: createProjectionDocumentCollection<Record<string, unknown>>(),
          linkCollection: createProjectionLinkCollection(),
          dedupeCollection: createProjectionDedupeCollection()
        })
      }
    ];

    for (const { name, store } of stores) {
      const committed = await store.commitAtomicMany({
        mode: 'atomic-all',
        writes: [
          {
            routingKeySource: `${projectionName}:doc-1`,
            documents: [
              {
                documentId: `${name}-doc-1`,
                mode: 'full',
                fullDocument: { total: 1 },
                checkpoint: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' }
              }
            ],
            dedupe: {
              upserts: [{ key: `${name}:dedupe:3`, checkpoint: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' } }]
            }
          },
          {
            routingKeySource: `${projectionName}:doc-2`,
            documents: [
              {
                documentId: `${name}-doc-2`,
                mode: 'full',
                fullDocument: { total: 2 },
                checkpoint: { sequence: 9, timestamp: '2026-04-09T00:00:09.000Z' }
              }
            ],
            dedupe: {
              upserts: [{ key: `${name}:dedupe:9`, checkpoint: { sequence: 9, timestamp: '2026-04-09T00:00:09.000Z' } }]
            }
          }
        ]
      });

      expect(committed.status).toBe('committed');
      if (committed.status === 'committed') {
        expect(committed.highestWatermark).toEqual({ sequence: 9, timestamp: '2026-04-09T00:00:09.000Z' });
        expect(committed.byLaneWatermark?.[`${projectionName}:doc-1`]).toEqual({
          sequence: 3,
          timestamp: '2026-04-09T00:00:03.000Z'
        });
        expect(committed.byLaneWatermark?.[`${projectionName}:doc-2`]).toEqual({
          sequence: 9,
          timestamp: '2026-04-09T00:00:09.000Z'
        });
      }

      const rejected = await store.commitAtomicMany({
        mode: 'atomic-all',
        writes: []
      });

      expect(rejected).toEqual({
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex: 0,
        failure: {
          category: 'terminal',
          code: 'invalid-request',
          message: 'no writes',
          retryable: false
        },
        reason: 'no writes',
        committedCount: 0
      });
    }
  });
});
