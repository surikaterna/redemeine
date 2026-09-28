import {
  assertEquivalentSagaCommit,
  assertSagaTurnJsonSafe,
  assertSagaTurnIntentBudget,
  assertSagaTurnPreappendBudget,
  type SagaTurnAppendRequest,
  type SagaTurnAppendResult,
  SagaTurnIntegrityError,
  type SagaTurnRepository,
  type SagaTurnStoredCommit,
  type SagaTurnStreamSnapshot
} from '@redemeine/saga-runtime';
import { ConcurrencyError, DuplicateCommitError, type ICommit, type IPersistencePartition } from 'tapeworm';
import { BSON, type Db, ObjectId, UUID } from 'mongodb';
import MongoPersistence from 'tapeworm_persistence_store_mongodb';
import type { CreateTapewormSagaTurnRepositoryOptions, TapewormSagaEvent } from './contracts';
import { assertSagaCommitBudget, IndexedSagaCommitReader, SAGA_COMMIT_EVENTS, SAGA_EVENT_BYTES, SAGA_INSTANCE_BYTES, SAGA_INSTANCE_COMMITS } from './IndexedSagaCommitReader';
import { storedCommitFromTapeworm, validateTapewormCommit } from './validation';

function assertOptions(options: CreateTapewormSagaTurnRepositoryOptions): void {
  if (options.partitionId.length === 0) throw new TypeError('partitionId must not be empty');
}

function tapewormEventId(commitId: string, position: number): string {
  return `${commitId}:event:${position}`;
}

function buildCommit(request: SagaTurnAppendRequest, partitionId: string, firstEventVersion: number): ICommit<TapewormSagaEvent> {
  return {
    id: request.commitId,
    partitionId,
    streamId: request.streamId,
    commitSequence: request.expectedNextCommitSequence,
    sagaTurnIdentity: request.identity,
    events: request.events.map((event, position) => ({
      id: tapewormEventId(request.commitId, position),
      type: event.type,
      version: firstEventVersion + position,
      payload: event.payload,
      ...(event.headers === undefined ? {} : { headers: event.headers }),
      ...(event.metadata === undefined ? {} : { metadata: event.metadata })
    }))
  };
}

function incompatibleCommit(request: SagaTurnAppendRequest, actualIdentity?: SagaTurnStoredCommit['identity'], cause?: unknown): SagaTurnIntegrityError {
  return new SagaTurnIntegrityError(
    'incompatible_turn_commit',
    'Deterministic commit ID is already used by an incompatible saga turn',
    {
      commitId: request.commitId,
      streamId: request.streamId,
      expectedIdentity: request.identity,
      ...(actualIdentity === undefined ? {} : { actualIdentity })
    },
    cause
  );
}

export class TapewormSagaTurnRepository implements SagaTurnRepository {
  private readonly options: CreateTapewormSagaTurnRepositoryOptions;
  readonly partitionId: string;

  constructor(options: CreateTapewormSagaTurnRepositoryOptions) {
    assertOptions(options);
    this.options = options;
    this.partitionId = options.partitionId;
  }

  async load(instanceId: string): Promise<SagaTurnStreamSnapshot> {
    const high = await this.options.reader.capture(instanceId);
    return {
      streamId: instanceId,
      nextCommitSequence: high + 1,
      commits: this.scan(instanceId, high)
    };
  }

  async findCommit(streamId: string, commitId: string): Promise<SagaTurnStoredCommit | null> {
    const high = await this.options.reader.capture(streamId);
    let found: SagaTurnStoredCommit | null = null;
    for await (const commit of this.scan(streamId, high)) {
      if (commit.commitId === commitId) {
        if (found) throw new SagaTurnIntegrityError('duplicate_turn_commits', 'Duplicate saga commit ID within stream');
        found = commit;
      }
    }
    return found;
  }

  assertCommitMaterial(stored: SagaTurnStoredCommit, request: SagaTurnAppendRequest, firstEventVersion: number): void {
    if (stored.commitSequence !== request.expectedNextCommitSequence) {
      throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Original saga commit sequence differs from reconstructed prefix');
    }
    assertEquivalentSagaCommit(stored, request, this.options.partitionId, firstEventVersion);
  }

  async append(request: SagaTurnAppendRequest): Promise<SagaTurnAppendResult> {
    if (!Array.isArray(request.events) || request.events.length === 0 || request.events.length > SAGA_COMMIT_EVENTS) {
      throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Saga append event count exceeds complete-commit limit');
    }
    for (const event of request.events) {
      if (BSON.calculateObjectSize(event) > SAGA_EVENT_BYTES) {
        throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Saga append event exceeds BSON byte limit');
      }
    }
    assertSagaTurnJsonSafe(request);
    assertSagaTurnIntentBudget(request.events);
    const before = await this.readBeforeAppend(request.streamId, request.commitId);
    const existing = before.existing;
    if (existing) {
      assertEquivalentSagaCommit(existing, request, this.options.partitionId, existing.events[0]!.version);
      return { status: 'reconciled', commit: existing };
    }
    if (before.nextCommitSequence !== request.expectedNextCommitSequence) return { status: 'conflict' };
    if (before.nextCommitSequence >= SAGA_INSTANCE_COMMITS) {
      throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Saga instance commit budget exceeded');
    }
    const commit = buildCommit(request, this.options.partitionId, before.nextEventVersion);
    assertSagaTurnPreappendBudget(request, this.partitionId, before.nextEventVersion);
    const commitBytes = assertSagaCommitBudget({ ...commit, _id: new ObjectId(),
      token: new UUID('00000000-0000-0000-0000-000000000000'), isDispatched: false, createDateTime: new Date() });
    if (before.totalBytes + commitBytes > SAGA_INSTANCE_BYTES) {
      throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Saga instance byte budget exceeded');
    }
    try {
      const appended = await this.options.partition.append(commit);
      return { status: 'committed', commitSequence: appended.commitSequence };
    } catch (error) {
      return this.reconcileAppendFailure(error, request);
    }
  }

  private async *scan(streamId: string, high: number, usage?: { bytes: number }): AsyncGenerator<SagaTurnStoredCommit> {
    let after = -1;
    let version = 0;
    let totalBytes = 0;
    if (high >= SAGA_INSTANCE_COMMITS) throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Saga instance commit budget exceeded');
    while (after < high) {
      const page = await this.options.reader.page(streamId, after, high);
      if (page.afterSequence <= after || page.highWatermark !== high || page.commits.length > 64) {
        throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Saga indexed reader made no bounded progress');
      }
      for (const row of page.commits) {
        totalBytes += assertSagaCommitBudget(row, Object.hasOwn(row, '_id'));
        if (totalBytes > SAGA_INSTANCE_BYTES) throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Saga instance byte budget exceeded');
        if (usage) usage.bytes = totalBytes;
        const validated = validateTapewormCommit(row, this.options.partitionId, streamId, ++after, version);
        version += validated.events.length;
        yield storedCommitFromTapeworm(validated.commit);
      }
      if (page.afterSequence !== after) throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Invalid page continuation');
    }
  }

  private async readBeforeAppend(streamId: string, commitId: string) {
    const high = await this.options.reader.capture(streamId);
    if (high >= SAGA_INSTANCE_COMMITS) throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Saga instance commit budget exceeded');
    let nextEventVersion = 0;
    const usage = { bytes: 0 };
    let existing: SagaTurnStoredCommit | null = null;
    for await (const commit of this.scan(streamId, high, usage)) {
      if (commit.commitId === commitId) existing = commit;
      nextEventVersion += commit.events.length;
      if (!Number.isSafeInteger(nextEventVersion)) throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Saga event version overflow');
    }
    return { nextCommitSequence: high + 1, nextEventVersion, totalBytes: usage.bytes, existing };
  }

  private async reconcileAppendFailure(error: unknown, request: SagaTurnAppendRequest): Promise<SagaTurnAppendResult> {
    let readback: Awaited<ReturnType<TapewormSagaTurnRepository['readBeforeAppend']>>;
    try {
      readback = await this.readBeforeAppend(request.streamId, request.commitId);
    } catch (readbackError) {
      if (readbackError instanceof SagaTurnIntegrityError) throw readbackError;
      throw error;
    }
    const expectedStreamCommit = readback.existing;
    if (expectedStreamCommit) {
      assertEquivalentSagaCommit(expectedStreamCommit, request, this.options.partitionId, expectedStreamCommit.events[0]!.version);
      return { status: 'reconciled', commit: expectedStreamCommit };
    }
    if (error instanceof ConcurrencyError) return { status: 'conflict' };
    if (error instanceof DuplicateCommitError) throw incompatibleCommit(request, undefined, error);
    throw error;
  }
}

export function createTapewormSagaTurnRepository(options: CreateTapewormSagaTurnRepositoryOptions): TapewormSagaTurnRepository {
  return new TapewormSagaTurnRepository(options);
}

export async function openMongoSagaTurnRepository(db: Db, partitionId: string): Promise<TapewormSagaTurnRepository> {
  if (!partitionId) throw new TypeError('Saga partition ID is required');
  const provider = new MongoPersistence(db);
  const partition = await provider.openPartition(partitionId);
  const reader = new IndexedSagaCommitReader(db.collection<ICommit<TapewormSagaEvent>>(`tw_${partitionId}_commits`), partitionId);
  await reader.capture('__saga_index_readiness__');
  return new TapewormSagaTurnRepository({ partition: partition as unknown as IPersistencePartition<TapewormSagaEvent>, partitionId, reader });
}
