import { assertSagaTurnJsonSafe, SagaTurnIntegrityError,
  SAGA_TURN_MAX_EVENTS, SAGA_TURN_MAX_EVENT_BSON_BYTES, SAGA_TURN_MAX_COMMIT_BSON_BYTES } from '@redemeine/saga-runtime';
import { BSON, type Collection, type IndexDescriptionInfo, UUID } from 'mongodb';
import type { ICommit } from 'tapeworm';
import type { TapewormSagaEvent } from './contracts';
import { storedCommitFromTapeworm, validateTapewormCommit } from './validation';

export const SAGA_PAGE_COMMITS = 64;
export const SAGA_PAGE_BYTES = 12 * 1024 * 1024;
export const SAGA_EVENT_BYTES = SAGA_TURN_MAX_EVENT_BSON_BYTES;
export const SAGA_COMMIT_EVENTS = SAGA_TURN_MAX_EVENTS;
// Four MiB below Mongo's BSON limit, including the actual persisted Tapeworm envelope.
export const SAGA_COMMIT_BYTES = SAGA_TURN_MAX_COMMIT_BSON_BYTES;
export const SAGA_INSTANCE_COMMITS = 1_000_000;
export const SAGA_INSTANCE_BYTES = 1024 * 1024 * 1024;

type SagaCollection = Collection<ICommit<TapewormSagaEvent>>;

export interface SagaCommitPage {
  readonly commits: readonly ICommit<TapewormSagaEvent>[];
  readonly afterSequence: number;
  readonly highWatermark: number;
}

export interface SagaCommitReader {
  capture(streamId: string): Promise<number>;
  page(streamId: string, afterSequence: number, highWatermark: number): Promise<SagaCommitPage>;
}

function invalid(reason: string): never {
  throw new SagaTurnIntegrityError('invalid_tapeworm_stream', reason);
}

function usable(index: IndexDescriptionInfo): index is IndexDescriptionInfo & { name: string } {
  const keys = Object.entries(index.key ?? {});
  return typeof index.name === 'string' && index.name.length > 0 && index.unique === true
    && keys.length === 2 && keys[0]?.[0] === 'streamId' && keys[0]?.[1] === 1
    && keys[1]?.[0] === 'commitSequence' && keys[1]?.[1] === 1
    && index.hidden !== true && index.sparse !== true && index.partialFilterExpression === undefined
    && index.expireAfterSeconds === undefined
    && (index.collation === undefined || index.collation.locale === 'simple');
}

export function assertSagaCommitBudget(value: unknown, persisted = false): number {
  if (typeof value !== 'object' || value === null) return invalid('Saga commit must be an object');
  const row = value as Record<string, unknown>;
  const bytes = BSON.calculateObjectSize(row);
  if (bytes > SAGA_COMMIT_BYTES) return invalid('Saga complete commit exceeds the BSON byte limit');
  if (!Array.isArray(row.events) || row.events.length === 0 || row.events.length > SAGA_COMMIT_EVENTS) {
    return invalid('Saga commit event count exceeds the bounded complete-commit limit');
  }
  for (const event of row.events) {
    assertSagaTurnJsonSafe(event);
    if (BSON.calculateObjectSize(event) > SAGA_EVENT_BYTES) return invalid('Saga event exceeds the BSON byte limit');
  }
  if (persisted) {
    if (Object.keys(row).some((key) => !['id', 'partitionId', 'streamId', 'commitSequence', 'events',
      'sagaTurnIdentity', '_id', 'token', 'isDispatched', 'createDateTime'].includes(key))) return invalid('Unsupported Mongo commit field');
    if (!(row._id instanceof BSON.ObjectId) || !(row.token instanceof UUID)
      || typeof row.isDispatched !== 'boolean' || !(row.createDateTime instanceof Date)
      || Number.isNaN(row.createDateTime.getTime())) return invalid('Malformed Mongo commit envelope');
    if (typeof row.id !== 'string' || !row.id || typeof row.partitionId !== 'string'
      || typeof row.streamId !== 'string' || !Number.isSafeInteger(row.commitSequence)) return invalid('Malformed Mongo commit identity');
  }
  return bytes;
}

export class IndexedSagaCommitReader implements SagaCommitReader {
  constructor(private readonly collection: SagaCollection, private readonly partitionId: string) {
    if (!partitionId || collection.collectionName !== `tw_${partitionId}_commits`) {
      throw new TypeError('Saga reader must use its writable Tapeworm partition commits collection');
    }
  }

  private async indexName(): Promise<string> {
    const indexes = await this.collection.listIndexes().toArray();
    const matching = indexes.filter(usable);
    if (matching.length !== 1) return invalid('Exactly one usable unique saga stream sequence index is required');
    return matching[0]!.name;
  }

  async capture(streamId: string): Promise<number> {
    const index = await this.indexName();
    const cursor = this.collection.find({ streamId }).sort({ commitSequence: -1 }).hint(index).limit(1).batchSize(1);
    try {
      const row = await cursor.next();
      if (!row) return -1;
      if (!Number.isSafeInteger(row.commitSequence) || row.commitSequence < 0 || row.commitSequence >= SAGA_INSTANCE_COMMITS) {
        return invalid('Invalid indexed high watermark or instance commit budget exceeded');
      }
      assertSagaCommitBudget(row, true);
      storedCommitFromTapeworm(validateTapewormCommit(row, this.partitionId, streamId,
        row.commitSequence, row.events[0]?.version ?? -1).commit);
      return row.commitSequence;
    } finally {
      await cursor.close();
    }
  }

  async page(streamId: string, afterSequence: number, highWatermark: number): Promise<SagaCommitPage> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < -1 || !Number.isSafeInteger(highWatermark)
      || highWatermark < -1 || afterSequence > highWatermark) return invalid('Invalid saga page boundary');
    const index = await this.indexName();
    const commits: ICommit<TapewormSagaEvent>[] = [];
    let bytes = 0;
    const cursor = this.collection.find({ streamId, commitSequence: { $gt: afterSequence, $lte: highWatermark } })
      .sort({ commitSequence: 1 }).hint(index).limit(SAGA_PAGE_COMMITS + 1).batchSize(1);
    try {
      for await (const row of cursor) {
        if (row.partitionId !== this.partitionId || row.streamId !== streamId) return invalid('Wrong saga partition or stream');
        if (row.commitSequence !== afterSequence + commits.length + 1) return invalid('Saga stream commit sequence has a gap');
        const rowBytes = assertSagaCommitBudget(row, true);
        storedCommitFromTapeworm(validateTapewormCommit(row, this.partitionId, streamId,
          row.commitSequence, row.events[0]?.version ?? -1).commit);
        if (commits.length >= SAGA_PAGE_COMMITS || bytes + rowBytes > SAGA_PAGE_BYTES) {
          if (commits.length === 0) return invalid('First saga commit cannot fit into page');
          break;
        }
        commits.push(row);
        bytes += rowBytes;
      }
    } finally {
      await cursor.close();
    }
    const continuation = afterSequence + commits.length;
    if (commits.length === 0 && continuation < highWatermark) return invalid('Indexed saga history ends before captured high watermark');
    return { commits, afterSequence: continuation, highWatermark };
  }
}
