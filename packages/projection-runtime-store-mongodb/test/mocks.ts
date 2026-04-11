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

const isRecord = (value: unknown): value is AnyRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) {
        return false;
      }
    }

    return true;
  }

  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) {
        return false;
      }
      if (!deepEqual(left[key], right[key])) {
        return false;
      }
    }

    return true;
  }

  return false;
};

const cloneValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }

  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
  }

  return value;
};

const setFieldImmutable = (input: unknown, field: string, value: unknown): unknown => {
  const base = isRecord(input) ? { ...input } : {};
  base[field] = value;
  return base;
};

const unsetFieldImmutable = (input: unknown, field: string): unknown => {
  const base = isRecord(input) ? { ...input } : {};
  delete base[field];
  return base;
};

const getByPath = (doc: AnyRecord, path: string): unknown => {
  if (!path.includes('.')) {
    return doc[path];
  }

  const parts = path.split('.');
  let current: unknown = doc;
  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    current = (current as AnyRecord)[part];
  }

  return current;
};

const setByPath = (doc: AnyRecord, path: string, value: unknown): void => {
  if (!path.includes('.')) {
    doc[path] = value;
    return;
  }

  const parts = path.split('.');
  let current: AnyRecord = doc;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index] as string;
    const next = current[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as AnyRecord;
  }

  const leaf = parts[parts.length - 1] as string;
  current[leaf] = value;
};

const unsetByPath = (doc: AnyRecord, path: string): void => {
  if (!path.includes('.')) {
    delete doc[path];
    return;
  }

  const parts = path.split('.');
  let current: unknown = doc;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index] as string;
    if (!current || typeof current !== 'object') {
      return;
    }
    current = (current as AnyRecord)[part];
  }

  if (!current || typeof current !== 'object') {
    return;
  }

  const leaf = parts[parts.length - 1] as string;
  delete (current as AnyRecord)[leaf];
};

const isExpressionObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const evaluateExpression = (expression: unknown, root: AnyRecord): unknown => {
  if (Array.isArray(expression)) {
    return expression.map((entry) => evaluateExpression(entry, root));
  }

  if (typeof expression === 'string' && expression.startsWith('$')) {
    const path = expression.slice(1);
    return getByPath(root, path);
  }

  if (!isExpressionObject(expression)) {
    return expression;
  }

  if ('$concatArrays' in expression) {
    const parts = evaluateExpression(expression.$concatArrays, root);
    if (!Array.isArray(parts)) {
      return [];
    }

    return parts.flatMap((part) => (Array.isArray(part) ? part : []));
  }

  if ('$slice' in expression) {
    const args = evaluateExpression(expression.$slice, root);
    if (!Array.isArray(args) || args.length === 0 || !Array.isArray(args[0])) {
      return [];
    }

    const source = args[0];
    const start = typeof args[1] === 'number' ? args[1] : 0;
    if (args.length < 3) {
      if (start >= 0) {
        return source.slice(0, start);
      }

      return source.slice(start);
    }

    const count = typeof args[2] === 'number' ? args[2] : 0;
    return source.slice(start, start + count);
  }

  if ('$size' in expression) {
    const value = evaluateExpression(expression.$size, root);
    return Array.isArray(value) ? value.length : 0;
  }

  if ('$subtract' in expression) {
    const args = evaluateExpression(expression.$subtract, root);
    if (!Array.isArray(args) || args.length !== 2) {
      return 0;
    }

    const left = typeof args[0] === 'number' ? args[0] : 0;
    const right = typeof args[1] === 'number' ? args[1] : 0;
    return left - right;
  }

  if ('$eq' in expression) {
    const args = evaluateExpression(expression.$eq, root);
    if (!Array.isArray(args) || args.length !== 2) {
      return false;
    }

    return deepEqual(args[0], args[1]);
  }

  if ('$and' in expression) {
    const args = evaluateExpression(expression.$and, root);
    if (!Array.isArray(args)) {
      return false;
    }

    return args.every((entry) => entry === true);
  }

  if ('$ne' in expression) {
    const args = evaluateExpression(expression.$ne, root);
    if (!Array.isArray(args) || args.length !== 2) {
      return false;
    }

    return !deepEqual(args[0], args[1]);
  }

  if ('$type' in expression) {
    const value = evaluateExpression(expression.$type, root);
    if (value === undefined) {
      return 'missing';
    }
    if (value === null) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'array';
    }
    if (typeof value === 'object') {
      return 'object';
    }
    if (typeof value === 'boolean') {
      return 'bool';
    }
    if (typeof value === 'number') {
      return 'double';
    }
    return 'string';
  }

  if ('$getField' in expression && isRecord(expression.$getField)) {
    const input = evaluateExpression(expression.$getField.input, root);
    const field = evaluateExpression(expression.$getField.field, root);
    if (!isRecord(input) || typeof field !== 'string') {
      return undefined;
    }

    return input[field];
  }

  if ('$setField' in expression && isRecord(expression.$setField)) {
    const input = evaluateExpression(expression.$setField.input, root);
    const field = evaluateExpression(expression.$setField.field, root);
    const value = evaluateExpression(expression.$setField.value, root);
    if (typeof field !== 'string') {
      return input;
    }

    return setFieldImmutable(input, field, cloneValue(value));
  }

  if ('$unsetField' in expression && isRecord(expression.$unsetField)) {
    const input = evaluateExpression(expression.$unsetField.input, root);
    const field = evaluateExpression(expression.$unsetField.field, root);
    if (typeof field !== 'string') {
      return input;
    }

    return unsetFieldImmutable(input, field);
  }

  return expression;
};

const matches = <TDocument extends AnyRecord>(
  doc: TDocument,
  filter: Record<string, unknown>
): boolean => {
  const keys = Object.keys(filter);
  for (const key of keys) {
    if (key === '$expr') {
      if (evaluateExpression(filter.$expr, doc as AnyRecord) !== true) {
        return false;
      }
      continue;
    }

    if (getByPath(doc, key) !== filter[key]) {
      if (!deepEqual(getByPath(doc, key), filter[key])) {
        return false;
      }
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
      const candidate = this.records.get(filter._id);
      if (!candidate) {
        return null;
      }

      return matches(candidate as AnyRecord, filter) ? candidate : null;
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
    update: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>,
    options?: Pick<UpdateOptions, 'upsert' | 'session'>
  ): Promise<unknown> {
    this.operationLog.push({ op: 'updateOne', detail: { filter, update } });
    const current = await this.findOne(filter);

    if (!current && !options?.upsert) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const base = current ?? (({ _id: filter._id }) as TDocument);
    const next = { ...base } as AnyRecord;

    if (Array.isArray(update)) {
      for (const stage of update) {
        const set = (stage.$set as Record<string, unknown> | undefined) ?? {};
        for (const [path, value] of Object.entries(set)) {
          setByPath(next, path, evaluateExpression(value, next));
        }
      }
    } else {
      const set = (update.$set as Record<string, unknown> | undefined) ?? {};
      const unset = (update.$unset as Record<string, unknown> | undefined) ?? {};
      const push = (update.$push as Record<string, unknown> | undefined) ?? {};
      const pop = (update.$pop as Record<string, unknown> | undefined) ?? {};
      const setOnInsert =
        !current ? ((update.$setOnInsert as Partial<TDocument> | undefined) ?? {}) : {};

      Object.assign(next, setOnInsert);

      for (const [path, value] of Object.entries(set)) {
        setByPath(next, path, value);
      }

      for (const [path, value] of Object.entries(push)) {
        const currentValue = getByPath(next, path);
        if (Array.isArray(currentValue)) {
          currentValue.push(value);
        } else {
          setByPath(next, path, [value]);
        }
      }

      for (const [path, value] of Object.entries(pop)) {
        const currentValue = getByPath(next, path);
        if (!Array.isArray(currentValue) || currentValue.length === 0) {
          continue;
        }

        if (value === -1) {
          currentValue.shift();
          continue;
        }

        if (value === 1) {
          currentValue.pop();
        }
      }

      for (const path of Object.keys(unset)) {
        unsetByPath(next, path);
      }
    }

    this.records.set(next._id as string, next as TDocument);

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
