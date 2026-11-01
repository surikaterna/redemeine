import type {
  CommitProjectionSourceCommitRequest, FirstLiveEvidence, LiveSourceOrderPort, LiveSourcePosition,
  ProjectionCommitDefinition, ProjectionSourceCommit, ProjectionSourceCommitStorePort,
  LoadProjectionSourceCommitSnapshotRequest, ProjectionSourceCommitSnapshotTarget
} from '@redemeine/projection-runtime-core';

export const source = '00000000-0000-4000-8000-000000000001';
export type Counter = { count: number };

export function liveCommit(sequence: number, streamId = source): ProjectionSourceCommit {
  return { streamId, commitSequence: sequence, commitId: `00000000-0000-4000-8001-${String(sequence).padStart(12, '0')}`,
    events: [{ eventId: '00000000-0000-4000-8002-000000000001', eventIndex: 0, streamVersion: sequence,
      aggregateType: 'Counter', aggregateId: 'shared', type: 'Added', payload: { amount: 1 }, timestamp: '2026-09-29' }] };
}

export function liveDefinition(name = 'counter', strategy: 'in_document' | 'own_record' = 'in_document'): ProjectionCommitDefinition<Counter> {
  return { name, initialState: () => ({ count: 0 }), identity: (event) => event.aggregateId,
    subscriptions: [], deduplication: { strategy }, fromStream: {
      aggregate: { aggregateType: 'Counter', initialState: {}, pure: { eventProjectors: {} } },
      handlers: { Added: (state, event) => { state.count += Number(event.payload.amount); } }
    } };
}

export function floor(commit = liveCommit(42)): LiveSourcePosition {
  return { epoch: 'epoch', registryDigest: 'registry', sourceId: commit.streamId,
    firstSequence: commit.commitSequence, firstCommitId: commit.commitId, coveredThrough: null };
}

export class MemoryLiveOrder implements LiveSourceOrderPort {
  readonly positions = new Map<string, LiveSourcePosition>();
  loads = 0;
  async load(sourceId: string) { this.loads += 1; return this.positions.get(sourceId) ?? null; }
  async admitFirst(evidence: FirstLiveEvidence) {
    evidence.assertCurrent();
    this.positions.set(evidence.position.sourceId, evidence.position);
    return evidence.position;
  }
  async advanceCoverage(expected: LiveSourcePosition, sequence: number) {
    const current = this.positions.get(expected.sourceId);
    if (current?.coveredThrough !== expected.coveredThrough) throw new Error('CAS conflict');
    const next = { ...expected, coveredThrough: sequence };
    this.positions.set(expected.sourceId, next);
    return next;
  }
}

export class LiveCounterStore implements ProjectionSourceCommitStorePort<Counter> {
  readonly targets = new Map<string, ProjectionSourceCommitSnapshotTarget<Counter>>();
  readonly own = new Map<string, number>();
  readonly writes: CommitProjectionSourceCommitRequest<Counter>[] = [];
  failDefinition: string | undefined;

  async loadProjectionSourceCommitSnapshot(request: LoadProjectionSourceCommitSnapshotRequest) {
    return { targets: request.targetDocumentIds.map((id) => structuredClone(this.targets.get(`${request.projectionName}:${id}`)
      ?? { targetDocumentId: id, state: null, revision: null, sourceProgress: {} })), links: [],
      ownRecordSequence: this.own.get(`${request.projectionName}:${request.sourceId}`) ?? null };
  }

  async commitProjectionSourceCommit(request: CommitProjectionSourceCommitRequest<Counter>) {
    if (request.projectionName === this.failDefinition) throw new Error('injected failure');
    this.writes.push(request);
    for (const doc of request.finalDocuments) {
      const progress = request.progress.strategy === 'in_document'
        ? request.progress.targets.find((target) => target.targetDocumentId === doc.targetDocumentId)?.final ?? {} : {};
      this.targets.set(`${request.projectionName}:${doc.targetDocumentId}`, { targetDocumentId: doc.targetDocumentId,
        state: doc.finalDocument, revision: (doc.expectedRevision ?? 0) + 1, sourceProgress: progress });
    }
    if (request.progress.strategy === 'own_record') {
      this.own.set(`${request.projectionName}:${request.commit.streamId}`, request.commit.commitSequence);
    }
    return { version: 1 as const, status: 'committed' as const, commitSequence: request.commit.commitSequence,
      documentRevisions: {}, linkRevisions: {}, progress: request.progress };
  }
}
