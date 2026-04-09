import { IProjectionStore, Checkpoint } from '@redemeine/projection-runtime-core';
import type { ProjectionAtomicWrite } from '@redemeine/projection-runtime-core';

interface StoredDocument<TState> {
  state: TState;
  checkpoint: Checkpoint;
  updatedAt: string;
}

/**
 * In-memory implementation of IProjectionStore.
 *
 * Useful for:
 * - Unit testing projections without database setup
 * - Development and local testing
 * - E2E testing of the projection daemon
 *
 * WARNING: Data is NOT persisted between process restarts.
 */
export class InMemoryProjectionStore<TState = unknown> implements IProjectionStore<TState> {
  private documents = new Map<string, StoredDocument<TState>>();
  private links = new Map<string, string>();
  private dedupe = new Map<string, Checkpoint>();
  async load(id: string): Promise<TState | null> {
    const doc = this.documents.get(id);
    return doc ? doc.state : null;
  }

  async save(id: string, state: TState, cursor: Checkpoint): Promise<void> {
    // Atomic save - both state and checkpoint are updated together
    this.documents.set(id, {
      state,
      checkpoint: cursor,
      updatedAt: new Date().toISOString()
    });
  }

  async commitAtomic(write: ProjectionAtomicWrite<TState>): Promise<void> {
    for (const document of write.documents) {
      this.documents.set(document.documentId, {
        state: document.state,
        checkpoint: document.checkpoint,
        updatedAt: new Date().toISOString()
      });
    }

    for (const link of write.links) {
      const key = `${link.aggregateType}:${link.aggregateId}`;
      if (!this.links.has(key)) {
        this.links.set(key, link.targetDocId);
      }
    }

    this.documents.set(write.cursorKey, {
      state: {} as TState,
      checkpoint: write.cursor,
      updatedAt: new Date().toISOString()
    });

    for (const dedupe of write.dedupe.upserts) {
      this.dedupe.set(dedupe.key, dedupe.checkpoint);
    }
  }

  async resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> {
    return this.links.get(`${aggregateType}:${aggregateId}`) ?? null;
  }

  async exists(id: string): Promise<boolean> {
    return this.documents.has(id);
  }

  async delete(id: string): Promise<void> {
    this.documents.delete(id);
  }

  async getCheckpoint(id: string): Promise<Checkpoint | null> {
    const doc = this.documents.get(id);
    return doc ? doc.checkpoint : null;
  }

  async getDedupeCheckpoint(key: string): Promise<Checkpoint | null> {
    return this.dedupe.get(key) ?? null;
  }

  // Helper methods for testing
  clear(): void {
    this.documents.clear();
    this.links.clear();
    this.dedupe.clear();
  }

  getAll(): Map<string, StoredDocument<TState>> {
    return new Map(this.documents);
  }
}
