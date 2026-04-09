import { IProjectionStore, Checkpoint } from '@redemeine/projection-runtime-core';
import type { ProjectionAtomicWrite } from '@redemeine/projection-runtime-core';
import type {
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest,
  ProjectionStoreDocumentWrite
} from '@redemeine/projection-runtime-core';

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

  private static cloneCheckpoint(checkpoint: Checkpoint): Checkpoint {
    return {
      sequence: checkpoint.sequence,
      ...(checkpoint.timestamp ? { timestamp: checkpoint.timestamp } : {})
    };
  }

  private static chooseHigherWatermark(current: Checkpoint | null, next: Checkpoint): Checkpoint {
    if (!current) {
      return InMemoryProjectionStore.cloneCheckpoint(next);
    }

    if (next.sequence > current.sequence) {
      return InMemoryProjectionStore.cloneCheckpoint(next);
    }

    if (next.sequence === current.sequence && next.timestamp && (!current.timestamp || next.timestamp > current.timestamp)) {
      return InMemoryProjectionStore.cloneCheckpoint(next);
    }

    return current;
  }

  private static applyPatchDocument<TDoc>(existing: TDoc | undefined, patch: Record<string, unknown>): TDoc {
    const base =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};

    return {
      ...base,
      ...patch
    } as TDoc;
  }
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

      if (link.op === 'remove') {
        const existing = this.links.get(key);
        if (existing === link.targetDocId) {
          this.links.delete(key);
        }
        continue;
      }

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

  async commitAtomicMany(
    request: ProjectionStoreCommitAtomicManyRequest<TState>
  ): Promise<ProjectionStoreAtomicManyResult> {
    if (request.mode !== 'atomic-all') {
      return {
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex: 0,
        reason: `unsupported mode: ${request.mode}`,
        committedCount: 0
      };
    }

    if (request.writes.length === 0) {
      return {
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex: 0,
        reason: 'no writes',
        committedCount: 0
      };
    }

    const stagedDocuments = new Map(this.documents);
    const stagedDedupe = new Map(this.dedupe);
    const byLaneWatermark: Record<string, Checkpoint> = {};
    let highestWatermark: Checkpoint | null = null;

    const applyDocumentWrite = (write: ProjectionStoreDocumentWrite<TState>): void => {
      if (write.mode === 'full') {
        stagedDocuments.set(write.documentId, {
          state: write.fullDocument,
          checkpoint: InMemoryProjectionStore.cloneCheckpoint(write.checkpoint),
          updatedAt: new Date().toISOString()
        });
        return;
      }

      const current = stagedDocuments.get(write.documentId);
      stagedDocuments.set(write.documentId, {
        state: InMemoryProjectionStore.applyPatchDocument(current?.state, write.patch),
        checkpoint: InMemoryProjectionStore.cloneCheckpoint(write.checkpoint),
        updatedAt: new Date().toISOString()
      });
    };

    for (let index = 0; index < request.writes.length; index += 1) {
      const write = request.writes[index];
      let laneWatermark: Checkpoint | null = null;

      try {
        for (const document of write.documents) {
          applyDocumentWrite(document);
          laneWatermark = InMemoryProjectionStore.chooseHigherWatermark(laneWatermark, document.checkpoint);
          highestWatermark = InMemoryProjectionStore.chooseHigherWatermark(highestWatermark, document.checkpoint);
        }

        for (const dedupe of write.dedupe.upserts) {
          stagedDedupe.set(dedupe.key, InMemoryProjectionStore.cloneCheckpoint(dedupe.checkpoint));
          laneWatermark = InMemoryProjectionStore.chooseHigherWatermark(laneWatermark, dedupe.checkpoint);
          highestWatermark = InMemoryProjectionStore.chooseHigherWatermark(highestWatermark, dedupe.checkpoint);
        }
      } catch (error) {
        return {
          status: 'rejected',
          highestWatermark: null,
          failedAtIndex: index,
          reason: error instanceof Error ? error.message : 'atomicMany write failed',
          committedCount: 0
        };
      }

      if (laneWatermark) {
        byLaneWatermark[write.routingKeySource] = laneWatermark;
      }
    }

    this.documents = stagedDocuments;
    this.dedupe = stagedDedupe;

    return {
      status: 'committed',
      highestWatermark: highestWatermark ?? { sequence: 0 },
      byLaneWatermark,
      committedCount: request.writes.length
    };
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
