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
  ProjectionWorkerStateLoader,
  ProjectionWorkerStateRequest,
  ProjectionWorkerTransportMetadata
} from './contracts';

const DEFAULT_PRIORITY = 0;
const DEFAULT_RETRY_COUNT = 0;

type LaneSchedule = {
  tail: Promise<void>;
};

interface ProjectionStateCache {
  get(key: string): unknown | null | undefined;
  set(key: string, value: unknown | null): void;
  delete(key: string): void;
}

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

function createLruCache(maxEntries: number): ProjectionStateCache {
  const entries = new Map<string, unknown | null>();

  return {
    get(key: string): unknown | null | undefined {
      if (!entries.has(key)) {
        return undefined;
      }

      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value ?? null);
      return value;
    },
    set(key: string, value: unknown | null): void {
      if (entries.has(key)) {
        entries.delete(key);
      }

      entries.set(key, value);

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

async function processSingleCommit(
  processor: ProjectionWorkerProcessor,
  commit: ProjectionWorkerCommit,
  metadata: ProjectionWorkerProcessingMetadata,
  laneKeys: readonly string[],
  stateLoader: ProjectionWorkerStateLoader | undefined,
  stateCache: ProjectionStateCache | undefined
): Promise<ProjectionWorkerDecision> {
  const stateAccess = createProjectionStateAccess(commit, stateLoader, stateCache);
  return processor({
    commit,
    metadata,
    laneKeys,
    ...stateAccess
  });
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

    const decisions = await batchProcessor({
      commits,
      metadata,
      laneKeys,
      ...stateAccess
    });

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
  const stateCache = readPositiveInteger(options.stateCache?.maxEntries) !== undefined
    ? createLruCache(readPositiveInteger(options.stateCache?.maxEntries) as number)
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

      return {
        index,
        commit,
        metadata,
        laneKeys,
        laneKey
      };
    });

    const byLane = new Map<string, typeof commitEntries>();
    for (const entry of commitEntries) {
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
        const definition = laneEntries[0]?.commit.definition;
        if (definition === undefined) {
          return;
        }

        const batchMode = determineBatchMode(options, definition);

        if (batchMode === 'none') {
          for (const entry of laneEntries) {
            const decision = await processSingleCommit(
              processor,
              entry.commit,
              entry.metadata,
              entry.laneKeys,
              options.stateLoader,
              stateCache
            );

            resultItems[entry.index] = toResultItem(entry.commit, entry.metadata, decision);
          }

          return;
        }

        if (batchMode === 'single') {
          for (const entry of laneEntries) {
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

          return;
        }

        const decisions = await processBatch(
          processor,
          options.batchProcessor,
          laneEntries.map((entry) => entry.commit),
          laneEntries.map((entry) => entry.metadata),
          laneEntries.map((entry) => entry.laneKeys),
          options.stateLoader,
          stateCache
        );

        for (let index = 0; index < laneEntries.length; index += 1) {
          const entry = laneEntries[index];
          if (entry === undefined) {
            continue;
          }

          const decision = decisions[index] as ProjectionWorkerDecision;
          resultItems[entry.index] = toResultItem(entry.commit, entry.metadata, decision);
        }
      });
    });

    await Promise.all(laneRuns);

    return {
      items: resultItems
    };
  }

  return {
    push: pushOne,
    pushMany
  };
}
