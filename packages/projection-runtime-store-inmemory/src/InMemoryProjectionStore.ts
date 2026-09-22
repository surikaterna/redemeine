import type {
  Checkpoint,
  IProjectionStore,
  ProjectionAtomicWrite,
  CommitProjectionSourceCommitRequest,
  CommitProjectionSourceCommitResult,
  LoadProjectionSourceCommitSnapshotRequest,
  ProjectionSourceCommitSnapshot,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest
} from '@redemeine/projection-runtime-core';
import { executeCommitAtomicMany } from './internal/commitAtomicMany';
import type { StoredDocument } from './internal/storedDocument';
import { collectWarnings, commitV2, loadV2Snapshot, type ProjectionDedupeWarning, type V2State } from './internal/sourceCommitV2';

/**
 * In-memory projection storage for tests and local development.
 * Data is not persisted between process restarts.
 */
export class InMemoryProjectionStore<TState = unknown> implements IProjectionStore<TState> {
  private documents = new Map<string, StoredDocument<TState>>();
  private links = new Map<string, string>();
  private dedupe = new Map<string, Checkpoint>();
  private v2: V2State = { documentMetadata: new Map(), links: new Map(), ownProgress: new Map() };
  private readonly emittedWarnings = new Set<string>();

  constructor(private readonly options: { onDedupeWarning?: (warning: ProjectionDedupeWarning) => void } = {}) {}

  async load(id: string): Promise<TState | null> {
    const document = this.documents.get(id);
    return document ? document.state : null;
  }

  async save(id: string, state: TState, cursor: Checkpoint): Promise<void> {
    this.documents.set(id, { state, checkpoint: cursor, updatedAt: new Date().toISOString() });
  }

  async commitAtomic(write: ProjectionAtomicWrite<TState>): Promise<void> {
    for (const document of write.documents) {
      this.documents.set(document.documentId, {
        state: document.state,
        checkpoint: document.checkpoint,
        updatedAt: new Date().toISOString()
      });
    }
    this.applyLinks(write.links);
    this.documents.set(write.cursorKey, {
      state: {} as TState,
      checkpoint: write.cursor,
      updatedAt: new Date().toISOString()
    });
    for (const dedupe of write.dedupe.upserts) this.dedupe.set(dedupe.key, dedupe.checkpoint);
  }

  async commitAtomicMany(request: ProjectionStoreCommitAtomicManyRequest<TState>): Promise<ProjectionStoreAtomicManyResult> {
    const execution = executeCommitAtomicMany(request, this.documents, this.dedupe);
    if (execution.committedState) {
      this.documents = execution.committedState.documents;
      this.dedupe = execution.committedState.dedupe;
    }
    return execution.result;
  }

  async loadProjectionSourceCommitSnapshot(
    request: LoadProjectionSourceCommitSnapshotRequest
  ): Promise<ProjectionSourceCommitSnapshot<TState>> {
    return loadV2Snapshot(request, this.documents, this.v2);
  }

  async commitProjectionSourceCommit(
    request: CommitProjectionSourceCommitRequest<TState>
  ): Promise<CommitProjectionSourceCommitResult> {
    const execution = commitV2(request, this.documents, this.v2);
    if (!execution.documents || !execution.state) return execution.result;
    this.documents = execution.documents;
    this.v2 = execution.state;
    this.reportWarnings(request);
    return execution.result;
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
    return this.documents.get(id)?.checkpoint ?? null;
  }

  async getDedupeCheckpoint(key: string): Promise<Checkpoint | null> {
    return this.dedupe.get(key) ?? null;
  }

  clear(): void {
    this.documents.clear();
    this.links.clear();
    this.dedupe.clear();
    this.v2 = { documentMetadata: new Map(), links: new Map(), ownProgress: new Map() };
    this.emittedWarnings.clear();
  }

  getAll(): Map<string, StoredDocument<TState>> {
    return new Map(this.documents);
  }

  private applyLinks(links: ProjectionAtomicWrite<TState>['links']): void {
    for (const link of links) {
      const key = `${link.aggregateType}:${link.aggregateId}`;
      if (link.op === 'remove') {
        if (this.links.get(key) === link.targetDocId) this.links.delete(key);
      } else if (!this.links.has(key)) {
        this.links.set(key, link.targetDocId);
      }
    }
  }

  private reportWarnings(request: CommitProjectionSourceCommitRequest<TState>): void {
    for (const warning of collectWarnings(request)) {
      const key = `${warning.projectionName}:${warning.projectionGeneration}:${warning.targetDocumentId}:${warning.kind}`;
      if (this.emittedWarnings.has(key)) continue;
      this.emittedWarnings.add(key);
      try {
        this.options.onDedupeWarning?.(warning);
      } catch {
        // Telemetry must never alter a committed projection result.
      }
    }
  }
}
