import type {
  ProjectionDefinitionLike,
  ProjectionWorkerCommit,
  ProjectionWorkerCoreOptions,
  ProjectionWorkerDecision,
  ProjectionWorkerMicroBatchingMode,
  ProjectionWorkerProcessingMetadata,
  ProjectionWorkerResultItem,
  ProjectionWorkerStoreFailure,
  ProjectionWorkerTransportMetadata
} from './contracts';
import { evictStateCacheTargets, type ProjectionStateCache } from './workerStateAccess';

const DEFAULT_PRIORITY = 0;
const DEFAULT_RETRY_COUNT = 0;

export function normalizeMetadata(metadata?: ProjectionWorkerTransportMetadata): ProjectionWorkerProcessingMetadata {
  return { priority: metadata?.priority ?? DEFAULT_PRIORITY, retryCount: metadata?.retryCount ?? DEFAULT_RETRY_COUNT };
}

export function toResultItem(
  commit: ProjectionWorkerCommit,
  metadata: ProjectionWorkerProcessingMetadata,
  decision: ProjectionWorkerDecision
): ProjectionWorkerResultItem {
  return { definition: commit.definition, message: commit.message, metadata, decision };
}

export function uniqueLaneKeys(commit: ProjectionWorkerCommit): readonly string[] {
  return [...new Set(commit.message.routeDecision.targets.map((target) => target.laneKey))].sort();
}

export function fallbackLaneKey(commit: ProjectionWorkerCommit): string {
  return `${commit.definition.projectionName}:${commit.message.envelope.sourceId}`;
}

export function determineBatchMode(
  options: ProjectionWorkerCoreOptions,
  definition: ProjectionDefinitionLike
): ProjectionWorkerMicroBatchingMode {
  const configured = options.getProjectionConfig?.(definition)?.microBatching;
  return configured === 'single' || configured === 'all' || configured === 'none' ? configured : 'none';
}

type StoreFailureLike = { kind?: unknown; reason?: unknown; retryable?: unknown };

function normalizeStoreFailureReason(failure: ProjectionWorkerStoreFailure): string {
  if (failure.reason && failure.reason.length > 0) return failure.reason;
  if (failure.kind === 'conflict') return 'store-conflict';
  if (failure.kind === 'transient') return 'store-transient-failure';
  return 'store-terminal-failure';
}

function classifyStoreFailure(error: unknown): ProjectionWorkerStoreFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const failure = error as StoreFailureLike;
  if (failure.kind === 'conflict' || failure.kind === 'transient' || failure.kind === 'terminal') {
    return { kind: failure.kind, ...(typeof failure.reason === 'string' ? { reason: failure.reason } : {}) };
  }
  if (failure.retryable === true) {
    return { kind: 'transient', ...(typeof failure.reason === 'string' ? { reason: failure.reason } : {}) };
  }
  return undefined;
}

export function decideStoreFailureForCommit(
  stateCache: ProjectionStateCache | undefined,
  commit: ProjectionWorkerCommit,
  error: unknown
): ProjectionWorkerDecision | undefined {
  const failure = classifyStoreFailure(error);
  if (!failure) return undefined;
  if (failure.kind !== 'terminal') evictStateCacheTargets(stateCache, commit);
  const reason = normalizeStoreFailureReason(failure);
  return { status: 'nack', retryable: failure.kind !== 'terminal', reason };
}
