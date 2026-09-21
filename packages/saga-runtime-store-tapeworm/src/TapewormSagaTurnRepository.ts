import {
  SagaTurnIntegrityError,
  type SagaTurnAppendRequest,
  type SagaTurnAppendResult,
  type SagaTurnRepository,
  type SagaTurnStoredCommit,
  type SagaTurnStreamSnapshot
} from '@redemeine/saga-runtime';
import { ConcurrencyError, DuplicateCommitError, type ICommit } from 'tapeworm';
import type { CreateTapewormSagaTurnRepositoryOptions, TapewormSagaEvent } from './contracts';
import { storedCommitFromTapeworm, validateTapewormStream } from './validation';

function assertOptions(options: CreateTapewormSagaTurnRepositoryOptions): void {
  if (options.partitionId.length === 0) throw new TypeError('partitionId must not be empty');
  const readiness = options.readiness;
  if (!readiness.partitionOpened || !readiness.uniqueCommitIdIndexReady || !readiness.uniqueStreamSequenceIndexReady) {
    throw new TypeError('Tapeworm partition and required unique indexes must be ready before repository construction');
  }
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

function findById(commits: readonly ICommit<TapewormSagaEvent>[], commitId: string): ICommit<TapewormSagaEvent> | null {
  return commits.find(({ id }) => id === commitId) ?? null;
}

export class TapewormSagaTurnRepository implements SagaTurnRepository {
  private readonly options: CreateTapewormSagaTurnRepositoryOptions;

  constructor(options: CreateTapewormSagaTurnRepositoryOptions) {
    assertOptions(options);
    this.options = options;
  }

  async load(instanceId: string): Promise<SagaTurnStreamSnapshot> {
    const stream = await this.readStream(instanceId);
    return {
      streamId: instanceId,
      nextCommitSequence: stream.nextCommitSequence,
      events: stream.events
    };
  }

  async findCommit(streamId: string, commitId: string): Promise<SagaTurnStoredCommit | null> {
    const stream = await this.readStream(streamId);
    const commit = findById(stream.commits, commitId);
    return commit ? storedCommitFromTapeworm(commit) : null;
  }

  async append(request: SagaTurnAppendRequest): Promise<SagaTurnAppendResult> {
    const before = await this.readStream(request.streamId);
    if (before.nextCommitSequence !== request.expectedNextCommitSequence) return { status: 'conflict' };
    const commit = buildCommit(request, this.options.partitionId, before.nextEventVersion);
    try {
      const appended = await this.options.partition.append(commit);
      return { status: 'committed', commitSequence: appended.commitSequence };
    } catch (error) {
      return this.reconcileAppendFailure(error, request);
    }
  }

  private async readStream(streamId: string) {
    const commits: unknown = await this.options.partition.queryStream(streamId);
    return validateTapewormStream(commits, this.options.partitionId, streamId);
  }

  private async reconcileAppendFailure(error: unknown, request: SagaTurnAppendRequest): Promise<SagaTurnAppendResult> {
    let expectedStreamCommit: ICommit<TapewormSagaEvent> | null = null;
    try {
      expectedStreamCommit = findById((await this.readStream(request.streamId)).commits, request.commitId);
      if (expectedStreamCommit) return { status: 'reconciled', commit: storedCommitFromTapeworm(expectedStreamCommit) };
      await this.assertNoGlobalCommitAlias(request);
    } catch (readbackError) {
      if (readbackError instanceof SagaTurnIntegrityError) throw readbackError;
      throw error;
    }
    if (error instanceof ConcurrencyError) return { status: 'conflict' };
    if (error instanceof DuplicateCommitError) throw error;
    throw error;
  }

  private async assertNoGlobalCommitAlias(request: SagaTurnAppendRequest): Promise<void> {
    const all: unknown = await this.options.partition.queryAll();
    if (!Array.isArray(all)) throw new TypeError('Tapeworm queryAll result must be an array');
    const matching = all.find((candidate) => {
      return typeof candidate === 'object' && candidate !== null && 'id' in candidate && candidate.id === request.commitId;
    });
    if (matching) {
      throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Deterministic commit ID exists outside the expected saga stream');
    }
  }
}

export function createTapewormSagaTurnRepository(options: CreateTapewormSagaTurnRepositoryOptions): TapewormSagaTurnRepository {
  return new TapewormSagaTurnRepository(options);
}
