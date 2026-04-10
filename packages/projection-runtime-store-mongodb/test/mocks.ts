import type {
  AnyBulkWriteOperation,
  BulkWriteOptions,
  ClientSession,
  DeleteOptions,
  FindOptions,
  MongoClient,
  TransactionOptions,
  UpdateOptions
} from 'mongodb';
import type {
  MongoCollectionLike,
  ProjectionDocumentRecord,
  ProjectionDedupeRecord,
  ProjectionLinkRecord
} from '../src';

type AnyRecord = Record<string, unknown>;

const matches = <TDocument extends AnyRecord>(
  doc: TDocument,
  filter: Record<string, unknown>
): boolean => {
  const keys = Object.keys(filter);
  for (const key of keys) {
    if (doc[key] !== filter[key]) {
      return false;
    }
  }
  return true;
};

/**
 * Lightweight in-memory collection used by unit tests.
 *
 * It implements only the methods consumed by Mongo adapters.
 */
export class InMemoryMongoCollection<TDocument extends { _id: string }>
  implements MongoCollectionLike<TDocument>
{
  private static readonly allCollections = new Set<InMemoryMongoCollection<{ _id: string }>>();
  private readonly records = new Map<string, TDocument>();
  readonly operationLog: Array<{ op: 'bulkWrite' | 'updateOne' | 'deleteOne' | 'deleteMany' | 'findOne'; detail?: unknown }> = [];

  constructor() {
    InMemoryMongoCollection.allCollections.add(this as unknown as InMemoryMongoCollection<{ _id: string }>);
  }

  static captureAllSnapshots(): Array<{
    collection: InMemoryMongoCollection<{ _id: string }>;
    records: Map<string, { _id: string }>;
  }> {
    return Array.from(InMemoryMongoCollection.allCollections.values()).map((collection) => ({
      collection,
      records: collection.captureSnapshotForTransaction()
    }));
  }

  private captureSnapshotForTransaction(): Map<string, TDocument> {
    return new Map(this.records.entries());
  }

  restoreSnapshotForTransaction(records: Map<string, TDocument>): void {
    this.records.clear();
    for (const [key, value] of records.entries()) {
      this.records.set(key, value);
    }
  }

  async findOne(filter: Record<string, unknown>, options?: FindOptions<TDocument>): Promise<TDocument | null> {
    void options;
    this.operationLog.push({ op: 'findOne', detail: { filter } });
    if (typeof filter._id === 'string') {
      return this.records.get(filter._id) ?? null;
    }

    for (const value of this.records.values()) {
      if (matches(value as AnyRecord, filter)) {
        return value;
      }
    }

    return null;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Pick<UpdateOptions, 'upsert' | 'session'>
  ): Promise<unknown> {
    this.operationLog.push({ op: 'updateOne', detail: { filter, update } });
    const current = await this.findOne(filter);

    if (!current && !options?.upsert) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const base = current ?? (({ _id: filter._id }) as TDocument);
    const set = (update.$set as Partial<TDocument> | undefined) ?? {};
    const setOnInsert =
      !current ? ((update.$setOnInsert as Partial<TDocument> | undefined) ?? {}) : {};
    const next = { ...base, ...setOnInsert, ...set } as TDocument;
    this.records.set(next._id, next);

    return {
      matchedCount: current ? 1 : 0,
      modifiedCount: 1,
      upsertedCount: current ? 0 : 1
    };
  }

  async bulkWrite(
    operations: ReadonlyArray<AnyBulkWriteOperation<TDocument>>,
    options?: Pick<BulkWriteOptions, 'ordered' | 'session'>
  ): Promise<unknown> {
    void options;
    this.operationLog.push({ op: 'bulkWrite', detail: { count: operations.length } });

    let modifiedCount = 0;
    let upsertedCount = 0;
    let deletedCount = 0;

    for (const operation of operations) {
      if ('updateOne' in operation && operation.updateOne) {
        const result = (await this.updateOne(
          operation.updateOne.filter as Record<string, unknown>,
          operation.updateOne.update as Record<string, unknown>,
          {
            upsert: operation.updateOne.upsert
          }
        )) as { modifiedCount?: number; upsertedCount?: number };
        modifiedCount += result.modifiedCount ?? 0;
        upsertedCount += result.upsertedCount ?? 0;
        continue;
      }

      if ('deleteOne' in operation && operation.deleteOne) {
        const result = (await this.deleteOne(operation.deleteOne.filter as Record<string, unknown>)) as {
          deletedCount?: number;
        };
        deletedCount += result.deletedCount ?? 0;
        continue;
      }

      throw new Error('Unsupported bulkWrite operation in test mock');
    }

    return {
      modifiedCount,
      upsertedCount,
      deletedCount
    };
  }

  async deleteOne(filter: Record<string, unknown>, options?: Pick<DeleteOptions, 'session'>): Promise<unknown> {
    void options;
    this.operationLog.push({ op: 'deleteOne', detail: { filter } });
    if (typeof filter._id === 'string') {
      return { deletedCount: this.records.delete(filter._id) ? 1 : 0 };
    }

    for (const [key, value] of this.records.entries()) {
      if (matches(value as AnyRecord, filter)) {
        this.records.delete(key);
        return { deletedCount: 1 };
      }
    }

    return { deletedCount: 0 };
  }

  async deleteMany(filter: Record<string, unknown>, options?: Pick<DeleteOptions, 'session'>): Promise<unknown> {
    void options;
    this.operationLog.push({ op: 'deleteMany', detail: { filter } });
    let deleted = 0;
    for (const [key, value] of this.records.entries()) {
      if (matches(value as AnyRecord, filter)) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return { deletedCount: deleted };
  }

  snapshot(): TDocument[] {
    return Array.from(this.records.values());
  }
}

export const createProjectionDocumentCollection = <TState = unknown>(): InMemoryMongoCollection<ProjectionDocumentRecord<TState>> =>
  new InMemoryMongoCollection<ProjectionDocumentRecord<TState>>();

export const createProjectionLinkCollection = (): InMemoryMongoCollection<ProjectionLinkRecord> =>
  new InMemoryMongoCollection<ProjectionLinkRecord>();

export const createProjectionDedupeCollection = (): InMemoryMongoCollection<ProjectionDedupeRecord> =>
  new InMemoryMongoCollection<ProjectionDedupeRecord>();

type FakeMongoClientOptions = {
  failWithTransactionError?: Error & { code?: number; name?: string };
};

class FakeClientSession {
  constructor(private readonly options?: FakeMongoClientOptions) {}

  async withTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
    transactionOptions?: TransactionOptions
  ): Promise<T> {
    void transactionOptions;
    if (this.options?.failWithTransactionError) {
      throw this.options.failWithTransactionError;
    }

    const snapshots = InMemoryMongoCollection.captureAllSnapshots();

    try {
      return await work(this as ClientSession);
    } catch (error) {
      for (const snapshot of snapshots) {
        snapshot.collection.restoreSnapshotForTransaction(snapshot.records);
      }
      throw error;
    }
  }

  async endSession(): Promise<void> {}
}

export class FakeMongoClient {
  readonly sessions: FakeClientSession[] = [];

  constructor(private readonly options?: FakeMongoClientOptions) {}

  startSession(): ClientSession {
    const session = new FakeClientSession(this.options);
    this.sessions.push(session);
    return session as ClientSession;
  }
}

export const createFakeMongoClient = (options?: FakeMongoClientOptions): Pick<MongoClient, 'startSession'> => {
  return new FakeMongoClient(options);
};
