import { describe, expect, it } from '@jest/globals';
import type { ProjectionCheckpoint, Rfc6902Operation } from '../src';
import {
  InMemoryProjectionPersistenceAdapter,
  persistProjectedState,
  resolveProjectionPersistence,
  withProjectionMetadata
} from '../src';

describe('projection runtime persistence adapters', () => {
  it('persists through patch mode with root fields and unified _projection metadata', async () => {
    const adapter = new InMemoryProjectionPersistenceAdapter({ now: () => '2026-04-09T00:00:00.000Z' });
    const checkpoint: ProjectionCheckpoint = { sequence: 5, timestamp: '2026-04-09T00:00:00.000Z' };

    const first = await persistProjectedState({
      persistence: {
        patch: adapter,
        read: adapter,
        preferredMode: 'patch'
      },
      projectionName: 'orders_projection',
      documentId: 'order-1',
      nextState: {
        total: 100,
        status: 'created'
      },
      checkpoint,
      operations: [
        { op: 'add', path: '/total', value: 100 },
        { op: 'add', path: '/status', value: 'created' }
      ]
    });

    expect(first.mode).toBe('patch');
    expect(first.document.total).toBe(100);
    expect(first.document.status).toBe('created');
    expect(first.document._projection.projectionName).toBe('orders_projection');
    expect(first.document._projection.documentId).toBe('order-1');
    expect(first.document._projection.version).toBe(1);
    expect(first.document._projection.persistenceMode).toBe('patch');
    expect(first.document._projection.lastCheckpoint.sequence).toBe(5);
  });

  it('increments _projection.version exactly once for each successful patch update', async () => {
    const adapter = new InMemoryProjectionPersistenceAdapter({ now: () => '2026-04-09T00:00:00.000Z' });

    await persistProjectedState({
      persistence: { patch: adapter, read: adapter, preferredMode: 'patch' },
      projectionName: 'orders_projection',
      documentId: 'order-2',
      nextState: { total: 10 },
      checkpoint: { sequence: 1 }
    });

    await persistProjectedState({
      persistence: { patch: adapter, read: adapter, preferredMode: 'patch' },
      projectionName: 'orders_projection',
      documentId: 'order-2',
      nextState: { total: 30 },
      checkpoint: { sequence: 2 },
      operations: [{ op: 'replace', path: '/total', value: 30 }]
    });

    const stored = adapter.getDocumentSnapshot('orders_projection', 'order-2');
    expect(stored?._projection.version).toBe(2);
    expect(stored?.total).toBe(30);
  });

  it('persists through document mode and keeps metadata under _projection only', async () => {
    const adapter = new InMemoryProjectionPersistenceAdapter({ now: () => '2026-04-09T00:00:00.000Z' });

    const first = await persistProjectedState({
      persistence: {
        document: adapter,
        read: adapter,
        preferredMode: 'document'
      },
      projectionName: 'orders_projection',
      documentId: 'order-3',
      nextState: {
        total: 50,
        currency: 'EUR'
      },
      checkpoint: { sequence: 10 }
    });

    expect(first.mode).toBe('document');
    expect(first.document.total).toBe(50);
    expect(first.document.currency).toBe('EUR');
    expect((first.document as Record<string, unknown>).version).toBeUndefined();
    expect(first.document._projection.version).toBe(1);
    expect(first.document._projection.persistenceMode).toBe('document');
  });

  it('falls back by capability when preferred mode is unavailable', async () => {
    const adapter = new InMemoryProjectionPersistenceAdapter();

    const resolvedToDocument = resolveProjectionPersistence({
      preferredMode: 'patch',
      document: adapter,
      read: adapter
    });
    expect(resolvedToDocument.mode).toBe('document');

    const resolvedToPatch = resolveProjectionPersistence({
      preferredMode: 'document',
      patch: adapter,
      read: adapter
    });
    expect(resolvedToPatch.mode).toBe('patch');
  });

  it('fails startup/config clearly when no capability is configured', () => {
    expect(() => resolveProjectionPersistence({})).toThrow(
      'Projection runtime persistence configuration error: no persistence capability configured (expected patch and/or document capability).'
    );
  });

  it('fails startup/config clearly when no readable capability exists', () => {
    const writeOnlyPatch = {
      async persistPatch(): Promise<void> {
        return;
      }
    };

    expect(() => resolveProjectionPersistence({ patch: writeOnlyPatch })).toThrow(
      'Projection runtime persistence configuration error: no readable persistence capability configured (missing loadDocument implementation or explicit read capability).'
    );
  });

  it('does not increment version when persisted update fails', async () => {
    const adapter = new InMemoryProjectionPersistenceAdapter();

    await adapter.persistDocument({
      projectionName: 'orders_projection',
      documentId: 'order-4',
      document: withProjectionMetadata(
        { total: 40 },
        {
          projectionName: 'orders_projection',
          documentId: 'order-4',
          version: 1,
          lastCheckpoint: { sequence: 1 },
          updatedAt: '2026-04-09T00:00:00.000Z',
          persistenceMode: 'document'
        }
      )
    });

    const failingPatchOp: Rfc6902Operation[] = [{ op: 'replace', path: '/missing', value: 1 }];

    await expect(
      adapter.persistPatch({
        projectionName: 'orders_projection',
        documentId: 'order-4',
        operations: failingPatchOp,
        metadata: {
          projectionName: 'orders_projection',
          documentId: 'order-4',
          version: 999,
          lastCheckpoint: { sequence: 2 },
          updatedAt: '2026-04-09T00:01:00.000Z',
          persistenceMode: 'patch'
        }
      })
    ).rejects.toThrow('RFC6902 replace path not found "/missing".');

    const stored = adapter.getDocumentSnapshot('orders_projection', 'order-4');
    expect(stored?._projection.version).toBe(1);
  });
});
