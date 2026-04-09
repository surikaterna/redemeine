import type {
  MongoCollectionLike,
  ProjectionDocumentRecord,
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
  private readonly records = new Map<string, TDocument>();

  async findOne(filter: Record<string, unknown>): Promise<TDocument | null> {
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
    options?: { upsert?: boolean }
  ): Promise<unknown> {
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

  async deleteOne(filter: Record<string, unknown>): Promise<unknown> {
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

  async deleteMany(filter: Record<string, unknown>): Promise<unknown> {
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
