import {
  assertEquivalentSagaCommit,
  type SagaTurnAppendRequest,
  type SagaTurnAppendResult,
  SagaTurnIntegrityError,
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
    const existing = findById(before.commits, request.commitId);
    if (existing) {
      const stored = storedCommitFromTapeworm(existing);
      assertEquivalentSagaCommit(stored, request, this.options.partitionId, this.firstEventVersion(before.commits, stored.commitSequence));
      return { status: 'reconciled', commit: stored };
    }
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

  private firstEventVersion(commits: readonly ICommit<TapewormSagaEvent>[], sequence: number): number {
    return commits.slice(0, sequence).reduce((total, commit) => total + commit.events.length, 0);
  }

  private async reconcileAppendFailure(error: unknown, request: SagaTurnAppendRequest): Promise<SagaTurnAppendResult> {
    let readback: Awaited<ReturnType<TapewormSagaTurnRepository['readStream']>>;
    try {
      readback = await this.readStream(request.streamId);
    } catch (readbackError) {
      if (readbackError instanceof SagaTurnIntegrityError) throw readbackError;
      throw error;
    }
    const expectedStreamCommit = findById(readback.commits, request.commitId);
    if (expectedStreamCommit) {
      const stored = storedCommitFromTapeworm(expectedStreamCommit);
      assertEquivalentSagaCommit(stored, request, this.options.partitionId, this.firstEventVersion(readback.commits, stored.commitSequence));
      return { status: 'reconciled', commit: stored };
    }
    if (error instanceof ConcurrencyError) return { status: 'conflict' };
    if (error instanceof DuplicateCommitError) throw incompatibleCommit(request, undefined, error);
    throw error;
  }
}

export function createTapewormSagaTurnRepository(options: CreateTapewormSagaTurnRepositoryOptions): TapewormSagaTurnRepository {
  return new TapewormSagaTurnRepository(options);
}
