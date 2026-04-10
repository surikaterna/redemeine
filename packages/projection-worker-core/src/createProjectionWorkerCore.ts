import type {
  ProjectionDefinitionLike,
  ProjectionWorkerBatchProcessor,
  ProjectionWorkerCommit,
  ProjectionWorkerCoreOptions,
  ProjectionWorkerDecision,
  ProjectionWorkerMicroBatchingMode,
  ProjectionWorkerProcessingMetadata,
  ProjectionWorkerProcessor,
  ProjectionWorkerProjectionStateAccess,
  ProjectionWorkerPushContract,
  ProjectionWorkerPushManyResult,
  ProjectionWorkerPushResult,
  ProjectionWorkerResultItem,
  ProjectionWorkerStoreFailure,
  ProjectionWorkerStateLoader,
  ProjectionWorkerStateRequest,
  ProjectionWorkerTransportMetadata
} from './contracts';

const DEFAULT_PRIORITY = 0;
const DEFAULT_RETRY_COUNT = 0;
const DEFAULT_STATE_CACHE_TTL_MS = 10 * 60 * 1000;

type LaneSchedule = {
  tail: Promise<void>;
};

interface ProjectionStateCache {
  get(key: string): unknown | null | undefined;
  set(key: string, value: unknown | null): void;
  delete(key: string): void;
}

type CacheClock = () => number;

type ProjectionWorkerStoreFailureLike = {
  kind?: unknown;
  reason?: unknown;
  message?: unknown;
  retryable?: unknown;
};

function normalizeMetadata(
  metadata: ProjectionWorkerTransportMetadata | undefined
): ProjectionWorkerProcessingMetadata {
  return {
    priority: metadata?.priority ?? DEFAULT_PRIORITY,
    retryCount: metadata?.retryCount ?? DEFAULT_RETRY_COUNT
  };
}

function toResultItem(
  commit: ProjectionWorkerCommit,
  metadata: ProjectionWorkerProcessingMetadata,
  decision: ProjectionWorkerDecision
): ProjectionWorkerResultItem {
  return {
    definition: commit.definition,
    message: commit.message,
    metadata,
    decision
  };
}

function uniqueLaneKeys(commit: ProjectionWorkerCommit): readonly string[] {
  const routeTargets = commit.message.routeDecision.targets;
  if (routeTargets.length === 0) {
    return [];
  }

  const unique = new Set<string>();
  for (const target of routeTargets) {
    unique.add(target.laneKey);
  }

  return Array.from(unique).sort();
}

function computeLaneForCommit(commit: ProjectionWorkerCommit): string {
  const laneKeys = uniqueLaneKeys(commit);
  if (laneKeys.length > 0) {
    return laneKeys[0] as string;
  }

  const fallbackTargetId = commit.message.routeDecision.targets[0]?.targetId;
  const targetDocId = fallbackTargetId ?? commit.message.envelope.sourceId;
  return `${commit.definition.projectionName}:${targetDocId}`;
}

function computeStateKey(definition: ProjectionDefinitionLike, targetId: string): string {
  return `${definition.projectionName}:${targetId}`;
}

function readPositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const asInteger = Math.trunc(value);
  if (asInteger <= 0) {
    return undefined;
  }

  return asInteger;
}

function createLruCache(maxEntries: number, ttlMs: number, now: CacheClock): ProjectionStateCache {
  const entries = new Map<string, { value: unknown | null; expiresAt: number }>();

  function pruneExpiredFromOldest(): void {
    const nowMs = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt > nowMs) {
        break;
      }

      entries.delete(key);
    }
  }

  return {
    get(key: string): unknown | null | undefined {
      const existing = entries.get(key);
      if (existing === undefined) {
        return undefined;
      }

      const nowMs = now();
      if (existing.expiresAt <= nowMs) {
        entries.delete(key);
        return undefined;
      }

      entries.delete(key);
      entries.set(key, {
        value: existing.value,
        expiresAt: nowMs + ttlMs
      });
      return existing.value;
    },
    set(key: string, value: unknown | null): void {
      pruneExpiredFromOldest();

      if (entries.has(key)) {
        entries.delete(key);
      }

      entries.set(key, {
        value,
        expiresAt: now() + ttlMs
      });

      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (typeof oldestKey !== 'string') {
          break;
        }

        entries.delete(oldestKey);
      }
    },
    delete(key: string): void {
      entries.delete(key);
    }
  };
}

function createProjectionStateAccess(
  commit: ProjectionWorkerCommit,
  stateLoader: ProjectionWorkerStateLoader | undefined,
  stateCache: ProjectionStateCache | undefined
): ProjectionWorkerProjectionStateAccess {
  const loadedByTarget = new Map<string, unknown | null>();
  const hasLoadedTarget = new Set<string>();

  async function loadState(targetId: string): Promise<unknown | null> {
    if (hasLoadedTarget.has(targetId)) {
      return loadedByTarget.get(targetId) ?? null;
    }

    const cacheKey = computeStateKey(commit.definition, targetId);
    if (stateCache !== undefined) {
      const cached = stateCache.get(cacheKey);
      if (cached !== undefined) {
        loadedByTarget.set(targetId, cached);
        hasLoadedTarget.add(targetId);
        return cached;
      }
    }

    const request: ProjectionWorkerStateRequest = {
      definition: commit.definition,
      projectionName: commit.definition.projectionName,
      targetId
    };

    const loaded = stateLoader === undefined ? null : await stateLoader(request);
    const value = loaded ?? null;
    loadedByTarget.set(targetId, value);
    hasLoadedTarget.add(targetId);

    if (stateCache !== undefined) {
      stateCache.set(cacheKey, value);
    }

    return value;
  }

  function setProjectionState(targetId: string, state: unknown | null): void {
    const value = state ?? null;
    loadedByTarget.set(targetId, value);
    hasLoadedTarget.add(targetId);

    if (stateCache !== undefined) {
      const cacheKey = computeStateKey(commit.definition, targetId);
      stateCache.set(cacheKey, value);
    }
  }

  function evictProjectionState(targetId: string): void {
    loadedByTarget.delete(targetId);
    hasLoadedTarget.delete(targetId);

    if (stateCache !== undefined) {
      const cacheKey = computeStateKey(commit.definition, targetId);
      stateCache.delete(cacheKey);
    }
  }

  return {
    getProjectionState: loadState,
    setProjectionState,
    evictProjectionState
  };
}

function queueOnLane<T>(lane: LaneSchedule, run: () => Promise<T>): Promise<T> {
  const previous = lane.tail;
  let release: () => void = () => undefined;
  lane.tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous
    .then(run)
    .finally(() => {
      release();
    });
}

function queueOnLanes<T>(lanes: readonly LaneSchedule[], run: () => Promise<T>): Promise<T> {
  let chained = run;

  for (let index = lanes.length - 1; index >= 0; index -= 1) {
    const lane = lanes[index] as LaneSchedule;
    const next = chained;
    chained = () => queueOnLane(lane, next);
  }

  return chained();
}

function determineBatchMode(
  options: ProjectionWorkerCoreOptions,
  definition: ProjectionDefinitionLike
): ProjectionWorkerMicroBatchingMode {
  const configured = options.getProjectionConfig?.(definition)?.microBatching;
  if (configured === 'single' || configured === 'all' || configured === 'none') {
    return configured;
  }

  return 'none';
}

function normalizeStoreFailureReason(reason: string | undefined, kind: ProjectionWorkerStoreFailure['kind']): string {
  if (typeof reason === 'string' && reason.length > 0) {
    return reason;
  }

  if (kind === 'conflict') {
    return 'store-conflict';
  }

  if (kind === 'transient') {
    return 'store-transient-failure';
  }

  return 'store-terminal-failure';
}

function classifyStoreFailure(error: unknown): ProjectionWorkerStoreFailure | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const storeFailure = error as ProjectionWorkerStoreFailureLike;
  if (storeFailure.kind === 'conflict') {
    return {
      kind: 'conflict',
      reason: typeof storeFailure.reason === 'string'
        ? storeFailure.reason
        : normalizeStoreFailureReason(undefined, 'conflict')
    };
  }

  if (storeFailure.kind === 'transient') {
    return {
      kind: 'transient',
      reason: typeof storeFailure.reason === 'string'
        ? storeFailure.reason
        : normalizeStoreFailureReason(undefined, 'transient')
    };
  }

  if (storeFailure.kind === 'terminal') {
    return {
      kind: 'terminal',
      reason: typeof storeFailure.reason === 'string'
        ? storeFailure.reason
        : normalizeStoreFailureReason(undefined, 'terminal')
    };
  }

  if (storeFailure.retryable === true) {
    return {
      kind: 'transient',
      reason: typeof storeFailure.reason === 'string'
        ? storeFailure.reason
        : normalizeStoreFailureReason(undefined, 'transient')
    };
  }

  return undefined;
}

function toStoreFailureDecision(failure: ProjectionWorkerStoreFailure): ProjectionWorkerDecision {
  return {
    status: 'nack',
    retryable: failure.kind !== 'terminal',
    reason: normalizeStoreFailureReason(failure.reason, failure.kind)
  };
}

function collectStateTargetIds(commit: ProjectionWorkerCommit): readonly string[] {
  const targetIds = new Set<string>();
  for (const target of commit.message.routeDecision.targets) {
    targetIds.add(target.targetId);
  }

  if (targetIds.size === 0) {
    targetIds.add(commit.message.envelope.sourceId);
  }

  return Array.from(targetIds).sort();
}

function evictStateCacheTargets(
  stateCache: ProjectionStateCache | undefined,
  commit: ProjectionWorkerCommit
): void {
  if (stateCache === undefined) {
    return;
  }

  for (const targetId of collectStateTargetIds(commit)) {
    stateCache.delete(computeStateKey(commit.definition, targetId));
  }
}

function decideStoreFailureForCommit(
  stateCache: ProjectionStateCache | undefined,
  commit: ProjectionWorkerCommit,
  error: unknown
): ProjectionWorkerDecision | undefined {
  const failure = classifyStoreFailure(error);
  if (failure === undefined) {
    return undefined;
  }

  if (failure.kind !== 'terminal') {
    evictStateCacheTargets(stateCache, commit);
  }

  return toStoreFailureDecision(failure);
}

async function processSingleCommit(
  processor: ProjectionWorkerProcessor,
  commit: ProjectionWorkerCommit,
  metadata: ProjectionWorkerProcessingMetadata,
  laneKeys: readonly string[],
  stateLoader: ProjectionWorkerStateLoader | undefined,
  stateCache: ProjectionStateCache | undefined
): Promise<ProjectionWorkerDecision> {
  const stateAccess = createProjectionStateAccess(commit, stateLoader, stateCache);
  try {
    return await processor({
      commit,
      metadata,
      laneKeys,
      ...stateAccess
    });
  } catch (error) {
    const decision = decideStoreFailureForCommit(stateCache, commit, error);
    if (decision !== undefined) {
      return decision;
    }

    throw error;
  }
}

async function processBatch(
  processor: ProjectionWorkerProcessor,
  batchProcessor: ProjectionWorkerBatchProcessor | undefined,
  commits: readonly ProjectionWorkerCommit[],
  metadata: readonly ProjectionWorkerProcessingMetadata[],
  laneKeysByCommit: readonly (readonly string[])[],
  stateLoader: ProjectionWorkerStateLoader | undefined,
  stateCache: ProjectionStateCache | undefined
): Promise<readonly ProjectionWorkerDecision[]> {
  if (commits.length === 0) {
    return [];
  }

  if (batchProcessor !== undefined) {
    const first = commits[0] as ProjectionWorkerCommit;
    const stateAccess = createProjectionStateAccess(first, stateLoader, stateCache);

    const laneKeys = Array.from(
      new Set(
        laneKeysByCommit.flatMap((keys) => keys)
      )
    ).sort();

    let decisions: readonly ProjectionWorkerDecision[];
    try {
      decisions = await batchProcessor({
        commits,
        metadata,
        laneKeys,
        ...stateAccess
      });
    } catch (error) {
      const failureDecision = decideStoreFailureForCommit(stateCache, first, error);
      if (failureDecision === undefined) {
        throw error;
      }

      for (const commit of commits) {
        if (commit === first) {
          continue;
        }

        if (failureDecision.status === 'nack' && failureDecision.retryable) {
          evictStateCacheTargets(stateCache, commit);
        }
      }

      return commits.map(() => ({ ...failureDecision }));
    }

    if (decisions.length !== commits.length) {
      throw new Error('Batch processor must return one decision per commit.');
    }

    return decisions;
  }

  const decisions: ProjectionWorkerDecision[] = [];
  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index] as ProjectionWorkerCommit;
    const decision = await processSingleCommit(
      processor,
      commit,
      metadata[index] as ProjectionWorkerProcessingMetadata,
      laneKeysByCommit[index] as readonly string[],
      stateLoader,
      stateCache
    );
    decisions.push(decision);
  }

  return decisions;
}

export function createProjectionWorkerCore(
  optionsOrProcessor: ProjectionWorkerCoreOptions | ProjectionWorkerProcessor
): ProjectionWorkerPushContract {
  const options: ProjectionWorkerCoreOptions = typeof optionsOrProcessor === 'function'
    ? { processor: optionsOrProcessor }
    : optionsOrProcessor;

  const processor = options.processor;
  const lanes = new Map<string, LaneSchedule>();
  const stateCacheMaxEntries = readPositiveInteger(options.stateCache?.maxEntries);
  const stateCacheTtlMs = readPositiveInteger(options.stateCache?.ttlMs) ?? DEFAULT_STATE_CACHE_TTL_MS;
  const stateCacheNow = options.stateCache?.now ?? Date.now;
  const stateCache = stateCacheMaxEntries !== undefined
    ? createLruCache(stateCacheMaxEntries, stateCacheTtlMs, stateCacheNow)
    : undefined;

  function getLane(laneKey: string): LaneSchedule {
    const existing = lanes.get(laneKey);
    if (existing !== undefined) {
      return existing;
    }

    const created: LaneSchedule = {
      tail: Promise.resolve()
    };
    lanes.set(laneKey, created);
    return created;
  }

  async function pushOne(commit: ProjectionWorkerCommit): Promise<ProjectionWorkerPushResult> {
    const metadata = normalizeMetadata(commit.metadata);
    const laneKeys = uniqueLaneKeys(commit);
    const laneKey = computeLaneForCommit(commit);
    const lane = getLane(laneKey);

    const decision = await queueOnLane(lane, async () => {
      const decisions = await processBatch(
        processor,
        undefined,
        [commit],
        [metadata],
        [laneKeys],
        options.stateLoader,
        stateCache
      );

      return decisions[0] as ProjectionWorkerDecision;
    });

    return {
      item: toResultItem(commit, metadata, decision)
    };
  }

  async function pushMany(commits: readonly ProjectionWorkerCommit[]): Promise<ProjectionWorkerPushManyResult> {
    if (commits.length === 0) {
      return { items: [] };
    }

    const commitEntries = commits.map((commit, index) => {
      const metadata = normalizeMetadata(commit.metadata);
      const laneKeys = uniqueLaneKeys(commit);
      const laneKey = computeLaneForCommit(commit);
      const batchMode = determineBatchMode(options, commit.definition);

      return {
        index,
        commit,
        metadata,
        laneKeys,
        laneKey,
        batchMode
      };
    });

    const allByProjection = new Map<string, typeof commitEntries>();
    const nonAllEntries: typeof commitEntries = [];

    for (const entry of commitEntries) {
      if (entry.batchMode === 'all') {
        const projectionName = entry.commit.definition.projectionName;
        const grouped = allByProjection.get(projectionName);
        if (grouped === undefined) {
          allByProjection.set(projectionName, [entry]);
        } else {
          grouped.push(entry);
        }

        continue;
      }

      nonAllEntries.push(entry);
    }

    const byLane = new Map<string, typeof nonAllEntries>();
    for (const entry of nonAllEntries) {
      const laneEntries = byLane.get(entry.laneKey);
      if (laneEntries === undefined) {
        byLane.set(entry.laneKey, [entry]);
      } else {
        laneEntries.push(entry);
      }
    }

    const resultItems = new Array<ProjectionWorkerResultItem>(commits.length);
    const laneRuns = Array.from(byLane.entries()).map(async ([laneKey, laneEntries]) => {
      const lane = getLane(laneKey);
      return queueOnLane(lane, async () => {
        for (const entry of laneEntries) {
          if (entry.batchMode === 'none') {
            const decision = await processSingleCommit(
              processor,
              entry.commit,
              entry.metadata,
              entry.laneKeys,
              options.stateLoader,
              stateCache
            );

            resultItems[entry.index] = toResultItem(entry.commit, entry.metadata, decision);
            continue;
          }

          const decisions = await processBatch(
            processor,
            options.batchProcessor,
            [entry.commit],
            [entry.metadata],
            [entry.laneKeys],
            options.stateLoader,
            stateCache
          );

          const decision = decisions[0] as ProjectionWorkerDecision;
          resultItems[entry.index] = toResultItem(entry.commit, entry.metadata, decision);
        }
      });
    });

    const allRuns = Array.from(allByProjection.values()).map(async (projectionEntries) => {
      const laneKeys = Array.from(new Set(projectionEntries.map((entry) => entry.laneKey))).sort();
      const projectionLanes = laneKeys.map((laneKey) => getLane(laneKey));

      await queueOnLanes(projectionLanes, async () => {
        const decisions = await processBatch(
          processor,
          options.batchProcessor,
          projectionEntries.map((entry) => entry.commit),
          projectionEntries.map((entry) => entry.metadata),
          projectionEntries.map((entry) => entry.laneKeys),
          options.stateLoader,
          stateCache
        );

        for (let index = 0; index < projectionEntries.length; index += 1) {
          const entry = projectionEntries[index];
          if (entry === undefined) {
            continue;
          }

          const decision = decisions[index] as ProjectionWorkerDecision;
          resultItems[entry.index] = toResultItem(entry.commit, entry.metadata, decision);
        }
      });
    });

    await Promise.all([...laneRuns, ...allRuns]);

    return {
      items: resultItems
    };
  }

  return {
    push: pushOne,
    pushMany
  };
}
