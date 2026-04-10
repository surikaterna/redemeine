import { describe, expect, test } from 'bun:test';
import type { Checkpoint } from '../src';

type V3Failure = {
  category: 'conflict' | 'transient' | 'terminal';
  code: string;
  message: string;
  retryable: boolean;
};

type V3ConformanceStore = {
  commitAtomicMany(request: {
    mode: 'atomic-all';
    writes: ReadonlyArray<{
      routingKeySource: `${string}:${string}`;
      documents: ReadonlyArray<
        | {
          documentId: string;
          mode: 'full';
          fullDocument: Record<string, unknown>;
          checkpoint: Checkpoint;
          precondition?: {
            expectedRevision?: number | null;
            expectedCheckpoint?: Checkpoint | null;
          };
        }
        | {
          documentId: string;
          mode: 'patch';
          patch: Record<string, unknown>;
          checkpoint: Checkpoint;
          precondition?: {
            expectedRevision?: number | null;
            expectedCheckpoint?: Checkpoint | null;
          };
        }
      >;
      dedupe: { upserts: ReadonlyArray<{ key: string; checkpoint: Checkpoint }> };
    }>;
  }): Promise<
    | {
      status: 'committed';
      highestWatermark: Checkpoint;
      byLaneWatermark?: Readonly<Record<string, Checkpoint>>;
      committedCount: number;
    }
    | {
      status: 'rejected';
      highestWatermark: null;
      byLaneWatermark?: Readonly<Record<string, Checkpoint>>;
      failedAtIndex: number;
      failure: V3Failure;
      reason: string;
      committedCount: 0;
    }
  >;
  getDedupeCheckpoint(key: string): Promise<Checkpoint | null>;
  load(documentId: string): Promise<Record<string, unknown> | null>;
};

export function runV3StoreConformance(
  name: string,
  createStore: () => V3ConformanceStore
): void {
  describe(`${name} v3 store conformance`, () => {
    test('commitAtomicMany keeps full+patch parity and durable dedupe', async () => {
      const store = createStore();

      const result = await store.commitAtomicMany({
        mode: 'atomic-all',
        writes: [
          {
            routingKeySource: 'invoice-summary:doc-1',
            documents: [
              {
                documentId: 'doc-1',
                mode: 'full',
                fullDocument: { total: 5, status: 'open' },
                checkpoint: { sequence: 5, timestamp: '2026-04-09T00:00:05.000Z' }
              },
              {
                documentId: 'doc-1',
                mode: 'patch',
                patch: { total: 6 },
                checkpoint: { sequence: 6, timestamp: '2026-04-09T00:00:06.000Z' }
              }
            ],
            dedupe: {
              upserts: [{ key: 'invoice:1:6', checkpoint: { sequence: 6, timestamp: '2026-04-09T00:00:06.000Z' } }]
            }
          },
          {
            routingKeySource: 'invoice-summary:doc-2',
            documents: [
              {
                documentId: 'doc-2',
                mode: 'full',
                fullDocument: { total: 3, status: 'open' },
                checkpoint: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' }
              }
            ],
            dedupe: {
              upserts: [{ key: 'invoice:2:3', checkpoint: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' } }]
            }
          }
        ]
      });

      expect(result.status).toBe('committed');
      if (result.status === 'committed') {
        expect(result.committedCount).toBe(2);
        expect(result.highestWatermark).toEqual({ sequence: 6, timestamp: '2026-04-09T00:00:06.000Z' });
        expect(result.byLaneWatermark?.['invoice-summary:doc-1']).toEqual({ sequence: 6, timestamp: '2026-04-09T00:00:06.000Z' });
        expect(result.byLaneWatermark?.['invoice-summary:doc-2']).toEqual({ sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' });
      }

      expect(await store.load('doc-1')).toEqual({ total: 6, status: 'open' });
      expect(await store.load('doc-2')).toEqual({ total: 3, status: 'open' });
      expect(await store.getDedupeCheckpoint('invoice:1:6')).toEqual({ sequence: 6, timestamp: '2026-04-09T00:00:06.000Z' });
      expect(await store.getDedupeCheckpoint('invoice:2:3')).toEqual({ sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' });
    });

    test('commitAtomicMany returns rejected and null watermark on invalid request', async () => {
      const store = createStore();
      const result = await store.commitAtomicMany({ mode: 'atomic-all', writes: [] });

      expect(result).toEqual({
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
    });

    test('commitAtomicMany enforces OCC preconditions with conflict failure classification', async () => {
      const store = createStore();

      const seeded = await store.commitAtomicMany({
        mode: 'atomic-all',
        writes: [
          {
            routingKeySource: 'invoice-summary:doc-1',
            documents: [
              {
                documentId: 'doc-1',
                mode: 'full',
                fullDocument: { total: 3 },
                checkpoint: { sequence: 3 }
              }
            ],
            dedupe: { upserts: [] }
          }
        ]
      });

      expect(seeded.status).toBe('committed');

      const result = await store.commitAtomicMany({
        mode: 'atomic-all',
        writes: [
          {
            routingKeySource: 'invoice-summary:doc-1',
            documents: [
              {
                documentId: 'doc-1',
                mode: 'patch',
                patch: { total: 4 },
                checkpoint: { sequence: 4 },
                precondition: { expectedRevision: 2 }
              }
            ],
            dedupe: { upserts: [] }
          }
        ]
      });

      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.failure).toEqual({
          category: 'conflict',
          code: 'occ-conflict',
          message: "OCC precondition failed for document 'doc-1': expectedRevision=2, actualRevision=3",
          retryable: true
        });
        expect(result.reason).toBe(result.failure.message);
      }

      expect(await store.load('doc-1')).toEqual({ total: 3 });
    });

    test('highest watermark chooses newest timestamp when sequence ties', async () => {
      const store = createStore();
      const tied: Checkpoint = { sequence: 13, timestamp: '2026-04-09T00:00:13.999Z' };

      const result = await store.commitAtomicMany({
        mode: 'atomic-all',
        writes: [
          {
            routingKeySource: 'invoice-summary:doc-1',
            documents: [
              {
                documentId: 'doc-1',
                mode: 'full',
                fullDocument: { total: 13 },
                checkpoint: { sequence: 13, timestamp: '2026-04-09T00:00:13.100Z' }
              }
            ],
            dedupe: {
              upserts: [{ key: 'invoice:1:13', checkpoint: tied }]
            }
          }
        ]
      });

      expect(result.status).toBe('committed');
      if (result.status === 'committed') {
        expect(result.highestWatermark).toEqual(tied);
      }
    });
  });
}
