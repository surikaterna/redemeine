import { isDeepStrictEqual } from 'node:util';
import type { CommitProjectionSourceCommitRequest, CommitProjectionSourceCommitResult,
  LoadProjectionSourceCommitSnapshotRequest, ProjectionSourceCommitSnapshot,
  ProjectionSourceCommitSnapshotTarget, ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import type { CounterState } from '../fixtureRegistry';

export class ModelCounterStore implements ProjectionSourceCommitStorePort<CounterState> {
  private readonly documents = new Map<string, ProjectionSourceCommitSnapshotTarget<CounterState>>();
  private readonly progress = new Map<string, number>();

  constructor(private readonly trace: string[]) {}

  private key(projection: string, generation: string, id: string): string {
    return JSON.stringify([projection, generation, id]);
  }

  private snapshot(projection: string, generation: string, id: string): ProjectionSourceCommitSnapshotTarget<CounterState> {
    const current = this.documents.get(this.key(projection, generation, id));
    return { targetDocumentId: id, state: current?.state ? { ...current.state } : null,
      revision: current?.revision ?? null, sourceProgress: { ...current?.sourceProgress } };
  }

  async loadProjectionSourceCommitSnapshot(request: LoadProjectionSourceCommitSnapshotRequest)
    : Promise<ProjectionSourceCommitSnapshot<CounterState>> {
    if (request.links.length) throw new Error('model:links_unsupported');
    return { targets: request.targetDocumentIds.map((id) => this.snapshot(request.projectionName, request.projectionGeneration, id)), links: [],
      ownRecordSequence: this.progress.get(this.key(request.projectionName, request.projectionGeneration, request.sourceId ?? '')) ?? null };
  }

  private assertExpected(request: CommitProjectionSourceCommitRequest<CounterState>): void {
    if (request.stagedLinks.length || request.mode !== 'atomic-all') throw new Error('model:write_refused');
    for (const document of request.finalDocuments) {
      const current = this.documents.get(this.key(request.projectionName, request.projectionGeneration, document.targetDocumentId));
      if ((current?.revision ?? null) !== document.expectedRevision) throw new Error('model:revision_conflict');
      if (request.progress.strategy !== 'in_document') continue;
      const target = request.progress.targets.find((item) => item.targetDocumentId === document.targetDocumentId);
      if (!target || !isDeepStrictEqual(current?.sourceProgress ?? {}, target.expected)) throw new Error('model:progress_conflict');
    }
    if (request.progress.strategy !== 'own_record') return;
    const prior = this.progress.get(this.key(request.projectionName, request.projectionGeneration, request.commit.streamId)) ?? null;
    if (prior !== request.progress.source.expectedSequence || request.progress.source.baselineSequence !== undefined) {
      throw new Error('model:own_progress_conflict');
    }
  }

  async commitProjectionSourceCommit(request: CommitProjectionSourceCommitRequest<CounterState>)
    : Promise<CommitProjectionSourceCommitResult> {
    this.assertExpected(request);
    const snapshot = request;
    for (const document of snapshot.finalDocuments) {
      const sourceProgress = snapshot.progress.strategy === 'in_document'
        ? snapshot.progress.targets.find((target) => target.targetDocumentId === document.targetDocumentId)?.final ?? {} : {};
      this.documents.set(this.key(snapshot.projectionName, snapshot.projectionGeneration, document.targetDocumentId), {
        targetDocumentId: document.targetDocumentId, state: { ...document.finalDocument },
        revision: (document.expectedRevision ?? 0) + 1, sourceProgress: { ...sourceProgress } });
    }
    if (snapshot.progress.strategy === 'own_record') {
      this.progress.set(this.key(snapshot.projectionName, snapshot.projectionGeneration, snapshot.commit.streamId), snapshot.commit.commitSequence);
    }
    this.trace.push(`model:fold:${snapshot.projectionName}:${snapshot.commit.commitSequence}`);
    return { version: 1, status: 'committed', commitSequence: snapshot.commit.commitSequence,
      documentRevisions: {}, linkRevisions: {}, progress: snapshot.progress };
  }

  count(projection: string): number | null {
    return this.documents.get(this.key(projection, 'model:ephemeral-generation', 'shared'))?.state?.count ?? null;
  }
}
