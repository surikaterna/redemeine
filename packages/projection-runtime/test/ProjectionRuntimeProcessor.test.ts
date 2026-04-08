import { describe, expect, it } from '@jest/globals';
import {
  ProjectionRuntimeProcessor,
  type CommitFeedBatch,
  type CommitFeedContract,
  type CursorStoreContract,
  type LinkStoreContract,
  type PersistProjectionDocument,
  type ProjectedDocument,
  type ProjectionCheckpoint,
  type ProjectionCommit,
  type ProjectionCursor,
  type ProjectionReadContract,
  type DocumentProjectionPersistenceContract
} from '../src';

type TestState = {
  total: number;
  appliedSequences: number[];
  customerName?: string;
};

class InMemoryCommitFeed implements CommitFeedContract {
  constructor(private readonly commits: ProjectionCommit[]) {}

  async readAfter(checkpoint: ProjectionCheckpoint, limit: number): Promise<CommitFeedBatch> {
    const nextCommits = this.commits.filter((commit) => commit.sequence > checkpoint.sequence).slice(0, limit);
    const nextCheckpoint =
      nextCommits.length > 0
        ? { sequence: nextCommits[nextCommits.length - 1].sequence, timestamp: nextCommits[nextCommits.length - 1].timestamp }
        : checkpoint;

    return { commits: nextCommits, nextCheckpoint };
  }
}

class InMemoryCursorStore implements CursorStoreContract {
  public readonly saves: ProjectionCursor[] = [];
  private readonly cursors = new Map<string, ProjectionCursor>();

  async load(projectionName: string): Promise<ProjectionCursor | null> {
    return this.cursors.get(projectionName) ?? null;
  }

  async save(cursor: ProjectionCursor): Promise<void> {
    this.cursors.set(cursor.projectionName, cursor);
    this.saves.push(cursor);
  }
}

class InMemoryLinkStore implements LinkStoreContract {
  private readonly links = new Map<string, Set<string>>();

  async add(link: { key: { aggregateType: string; aggregateId: string }; targetDocumentId: string }): Promise<void> {
    const key = `${link.key.aggregateType}:${link.key.aggregateId}`;
    const targets = this.links.get(key) ?? new Set<string>();
    targets.add(link.targetDocumentId);
    this.links.set(key, targets);
  }

  async removeForTarget(targetDocumentId: string): Promise<void> {
    for (const targets of this.links.values()) {
      targets.delete(targetDocumentId);
    }
  }

  async resolveTargets(key: { aggregateType: string; aggregateId: string }): Promise<string[]> {
    return Array.from(this.links.get(`${key.aggregateType}:${key.aggregateId}`) ?? []);
  }
}

class InMemoryDocumentPersistence
  implements ProjectionReadContract<TestState>, DocumentProjectionPersistenceContract
{
  public readonly writes: PersistProjectionDocument[] = [];
  private readonly docs = new Map<string, ProjectedDocument<TestState>>();

  constructor(private readonly failPersist: boolean = false) {}

  async loadDocument(projectionName: string, documentId: string): Promise<ProjectedDocument<TestState> | null> {
    return this.docs.get(`${projectionName}:${documentId}`) ?? null;
  }

  async persistDocument(change: PersistProjectionDocument): Promise<void> {
    if (this.failPersist) {
      throw new Error('persist failed');
    }

    this.docs.set(`${change.projectionName}:${change.documentId}`, change.document as ProjectedDocument<TestState>);
    this.writes.push(change);
  }

  getDocument(projectionName: string, documentId: string): ProjectedDocument<TestState> | null {
    return this.docs.get(`${projectionName}:${documentId}`) ?? null;
  }
}

function createCommit(sequence: number, aggregateType: string, aggregateId: string, type: string, payload: Record<string, unknown>): ProjectionCommit {
  return {
    sequence,
    aggregateType,
    aggregateId,
    type,
    payload,
    timestamp: `2026-04-09T00:00:0${sequence}.000Z`
  };
}

function createProjectionDefinition(name: string, identity?: (event: ProjectionCommit) => string | readonly string[]) {
  return {
    name,
    initialState: () => ({ total: 0, appliedSequences: [] as number[] }),
    identity: identity ?? ((event: ProjectionCommit) => event.aggregateId),
    subscriptions: [],
    fromStream: {
      aggregate: { __aggregateType: 'order' },
      handlers: {
        'order.created': (state: TestState, event: ProjectionCommit, context: any) => {
          state.total += Number(event.payload.amount ?? 0);
          state.appliedSequences.push(event.sequence);
          const customerId = event.payload.customerId;
          if (typeof customerId === 'string') {
            context.subscribeTo({ __aggregateType: 'customer' }, customerId);
          }
        },
        'order.updated': (state: TestState, event: ProjectionCommit) => {
          state.total += Number(event.payload.amount ?? 0);
          state.appliedSequences.push(event.sequence);
        }
      }
    },
    joinStreams: [
      {
        aggregate: { __aggregateType: 'customer' },
        handlers: {
          'customer.updated': (state: TestState, event: ProjectionCommit) => {
            state.customerName = String(event.payload.name);
            state.appliedSequences.push(event.sequence);
          }
        }
      }
    ]
  } as any;
}

describe('ProjectionRuntimeProcessor', () => {
  it('routes from-stream events with identity fanout', async () => {
    const processor = new ProjectionRuntimeProcessor({
      projection: createProjectionDefinition('fanout-from', () => ['doc-1', 'doc-2', 'doc-1']),
      commitFeed: new InMemoryCommitFeed([createCommit(1, 'order', 'order-1', 'order.created', { amount: 3 })]),
      cursorStore: new InMemoryCursorStore(),
      linkStore: new InMemoryLinkStore(),
      persistence: new InMemoryDocumentPersistence()
    });

    const stats = await processor.processNextBatch();
    expect(stats.commitsRead).toBe(1);
    expect(stats.commitsApplied).toBe(1);
    expect(stats.documentsPersisted).toBe(2);
    expect(stats.cursorAdvanced).toBe(true);
  });

  it('routes join-stream events to 0..N targets and avoids ghost documents', async () => {
    const persistence = new InMemoryDocumentPersistence();
    const cursorStore = new InMemoryCursorStore();

    const processor = new ProjectionRuntimeProcessor({
      projection: createProjectionDefinition('join-fanout', () => ['invoice-a', 'invoice-b']),
      commitFeed: new InMemoryCommitFeed([
        createCommit(1, 'order', 'order-1', 'order.created', { customerId: 'customer-1' }),
        createCommit(2, 'customer', 'customer-1', 'customer.updated', { name: 'Nora' }),
        createCommit(3, 'customer', 'customer-missing', 'customer.updated', { name: 'Ghost' })
      ]),
      cursorStore,
      linkStore: new InMemoryLinkStore(),
      persistence
    });

    const stats = await processor.processNextBatch();
    expect(stats.commitsRead).toBe(3);
    expect(stats.commitsApplied).toBe(2);
    expect(stats.documentsPersisted).toBe(2);

    const invoiceA = persistence.getDocument('join-fanout', 'invoice-a');
    const invoiceB = persistence.getDocument('join-fanout', 'invoice-b');
    const ghost = persistence.getDocument('join-fanout', 'customer-missing');

    expect(invoiceA?._projection.version).toBe(2);
    expect(invoiceA?.customerName).toBe('Nora');
    expect(invoiceB?._projection.version).toBe(2);
    expect(invoiceB?.customerName).toBe('Nora');
    expect(ghost).toBeNull();
    expect(cursorStore.saves).toHaveLength(1);
    expect(cursorStore.saves[0]?.checkpoint.sequence).toBe(3);
  });

  it('folds multiple commits per document in sequence and persists once', async () => {
    const persistence = new InMemoryDocumentPersistence();

    const processor = new ProjectionRuntimeProcessor({
      projection: createProjectionDefinition('fold-sequence'),
      commitFeed: new InMemoryCommitFeed([
        createCommit(1, 'order', 'order-1', 'order.created', { amount: 1 }),
        createCommit(2, 'order', 'order-1', 'order.updated', { amount: 2 }),
        createCommit(3, 'order', 'order-1', 'order.updated', { amount: 3 })
      ]),
      cursorStore: new InMemoryCursorStore(),
      linkStore: new InMemoryLinkStore(),
      persistence
    });

    const stats = await processor.processNextBatch();
    expect(stats.documentsPersisted).toBe(1);
    expect(persistence.writes).toHaveLength(1);
    expect((persistence.writes[0]?.document as any).total).toBe(6);
    expect((persistence.writes[0]?.document as any).appliedSequences).toEqual([1, 2, 3]);
  });

  it('does not advance cursor when persistence fails', async () => {
    const cursorStore = new InMemoryCursorStore();

    const processor = new ProjectionRuntimeProcessor({
      projection: createProjectionDefinition('cursor-failure'),
      commitFeed: new InMemoryCommitFeed([createCommit(1, 'order', 'order-1', 'order.created', {})]),
      cursorStore,
      linkStore: new InMemoryLinkStore(),
      persistence: new InMemoryDocumentPersistence(true)
    });

    await expect(processor.processNextBatch()).rejects.toThrow('persist failed');
    expect(cursorStore.saves).toHaveLength(0);
  });
});
