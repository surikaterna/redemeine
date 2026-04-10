import type { IProjectionLinkStore } from './contracts';
import type { MongoProjectionLinkStoreOptions, ProjectionLinkRecord } from './types';

const defaultNow = (): string => new Date().toISOString();

const toLinkId = (aggregateType: string, aggregateId: string): string => `${aggregateType}:${aggregateId}`;

/**
 * Mongo-backed projection link store adapter.
 *
 * The link key is deterministic (`aggregateType:aggregateId`) to preserve
 * first-writer-wins behavior used by the current in-memory implementation.
 */
export class MongoProjectionLinkStore implements IProjectionLinkStore {
  private readonly now: () => string;

  constructor(private readonly options: MongoProjectionLinkStoreOptions) {
    this.now = options.now ?? defaultNow;
  }

  async addLink(aggregateType: string, aggregateId: string, targetDocId: string): Promise<void> {
    const _id = toLinkId(aggregateType, aggregateId);
    const record: ProjectionLinkRecord = {
      _id,
      aggregateType,
      aggregateId,
      targetDocId,
      createdAt: this.now()
    };

    await this.options.collection.bulkWrite(
      [
        {
          updateOne: {
            filter: { _id },
            update: {
              $setOnInsert: {
                aggregateType: record.aggregateType,
                aggregateId: record.aggregateId,
                targetDocId: record.targetDocId,
                createdAt: record.createdAt
              }
            },
            upsert: true
          }
        }
      ],
      { ordered: true }
    );
  }

  async resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> {
    const _id = toLinkId(aggregateType, aggregateId);
    const row = await this.options.collection.findOne({ _id });
    return row ? row.targetDocId : null;
  }

  async removeLinksForTarget(targetDocId: string): Promise<void> {
    await this.options.collection.deleteMany({ targetDocId });
  }
}

export { toLinkId };
