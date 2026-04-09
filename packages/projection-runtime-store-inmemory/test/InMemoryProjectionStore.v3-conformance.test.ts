import { describe, expect, test } from 'bun:test';
import { InMemoryProjectionStore } from '../src';

describe('InMemoryProjectionStore v3 conformance', () => {
  test('commitAtomicMany applies full+patch writes and returns highest watermark', async () => {
    const store = new InMemoryProjectionStore<{ total?: number; status?: string }>();

    const result = await store.commitAtomicMany({
      mode: 'atomic-all',
      writes: [
        {
          routingKeySource: 'invoice-summary:doc-1',
          documents: [
            {
              documentId: 'doc-1',
              mode: 'full',
              fullDocument: { total: 10, status: 'open' },
              checkpoint: { sequence: 10, timestamp: '2026-04-09T00:00:10.000Z' }
            },
            {
              documentId: 'doc-1',
              mode: 'patch',
              patch: { total: 12 },
              checkpoint: { sequence: 12, timestamp: '2026-04-09T00:00:12.000Z' }
            }
          ],
          dedupe: {
            upserts: [
              {
                key: 'invoice:1:12',
                checkpoint: { sequence: 12, timestamp: '2026-04-09T00:00:12.000Z' }
              }
            ]
          }
        },
        {
          routingKeySource: 'invoice-summary:doc-2',
          documents: [
            {
              documentId: 'doc-2',
              mode: 'full',
              fullDocument: { total: 8, status: 'open' },
              checkpoint: { sequence: 8, timestamp: '2026-04-09T00:00:08.000Z' }
            }
          ],
          dedupe: {
            upserts: [
              {
                key: 'invoice:2:8',
                checkpoint: { sequence: 8, timestamp: '2026-04-09T00:00:08.000Z' }
              }
            ]
          }
        }
      ]
    });

    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect(result.committedCount).toBe(2);
      expect(result.highestWatermark).toEqual({
        sequence: 12,
        timestamp: '2026-04-09T00:00:12.000Z'
      });
      expect(result.byLaneWatermark?.['invoice-summary:doc-1']).toEqual({
        sequence: 12,
        timestamp: '2026-04-09T00:00:12.000Z'
      });
      expect(result.byLaneWatermark?.['invoice-summary:doc-2']).toEqual({
        sequence: 8,
        timestamp: '2026-04-09T00:00:08.000Z'
      });
    }

    expect(await store.load('doc-1')).toEqual({ total: 12, status: 'open' });
    expect(await store.load('doc-2')).toEqual({ total: 8, status: 'open' });
    expect(await store.getDedupeCheckpoint('invoice:1:12')).toEqual({
      sequence: 12,
      timestamp: '2026-04-09T00:00:12.000Z'
    });
  });

  test('commitAtomicMany rejects empty writes with null highest watermark', async () => {
    const store = new InMemoryProjectionStore();

    const result = await store.commitAtomicMany({
      mode: 'atomic-all',
      writes: []
    });

    expect(result).toEqual({
      status: 'rejected',
      highestWatermark: null,
      failedAtIndex: 0,
      reason: 'no writes',
      committedCount: 0
    });
  });

  test('commitAtomicMany rejects at failing index and keeps atomic-all behavior', async () => {
    const store = new InMemoryProjectionStore<Record<string, unknown>>();

    const throwingPatch: Record<string, unknown> = {};
    Object.defineProperty(throwingPatch, 'total', {
      enumerable: true,
      get() {
        throw new Error('injected patch evaluation failure');
      }
    });

    const result = await store.commitAtomicMany({
      mode: 'atomic-all',
      writes: [
        {
          routingKeySource: 'invoice-summary:doc-1',
          documents: [
            {
              documentId: 'doc-1',
              mode: 'full',
              fullDocument: { total: 1 },
              checkpoint: { sequence: 1 }
            }
          ],
          dedupe: {
            upserts: [{ key: 'invoice:1:1', checkpoint: { sequence: 1 } }]
          }
        },
        {
          routingKeySource: 'invoice-summary:doc-2',
          documents: [
            {
              documentId: 'doc-2',
              mode: 'patch',
              patch: throwingPatch,
              checkpoint: { sequence: 2 }
            }
          ],
          dedupe: {
            upserts: [{ key: 'invoice:2:2', checkpoint: { sequence: 2 } }]
          }
        }
      ]
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.highestWatermark).toBeNull();
      expect(result.failedAtIndex).toBe(1);
      expect(result.committedCount).toBe(0);
      expect(result.reason).toBe('injected patch evaluation failure');
    }

    expect(await store.load('doc-1')).toBeNull();
    expect(await store.getDedupeCheckpoint('invoice:1:1')).toBeNull();
  });
});
