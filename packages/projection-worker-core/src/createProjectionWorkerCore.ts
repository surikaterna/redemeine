import type {
  ProjectionWorkerBatchProcessor,
  ProjectionWorkerCommit,
  ProjectionWorkerCoreOptions,
  ProjectionWorkerDecision,
  ProjectionWorkerProcessingMetadata,
  ProjectionWorkerProcessor,
  ProjectionWorkerPushContract,
  ProjectionWorkerPushManyResult,
  ProjectionWorkerPushResult,
  ProjectionWorkerResultItem,
  ProjectionWorkerStateLoader
} from './contracts';
import { createProjectionLaneScheduler } from './targetLaneScheduler';
import {
  decideStoreFailureForCommit,
  determineBatchMode,
  fallbackLaneKey,
  normalizeMetadata,
  toResultItem,
  uniqueLaneKeys
} from './workerCoreSupport';
import {
  createLruCache,
  createProjectionStateAccess,
  evictStateCacheTargets,
  readPositiveInteger,
  type ProjectionStateCache
} from './workerStateAccess';

const DEFAULT_STATE_CACHE_TTL_MS = 10 * 60 * 1000;

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
  const lanes = createProjectionLaneScheduler();
  const stateCacheMaxEntries = readPositiveInteger(options.stateCache?.maxEntries);
  const stateCacheTtlMs = readPositiveInteger(options.stateCache?.ttlMs) ?? DEFAULT_STATE_CACHE_TTL_MS;
  const stateCacheNow = options.stateCache?.now ?? Date.now;
  const stateCache = stateCacheMaxEntries !== undefined
    ? createLruCache(stateCacheMaxEntries, stateCacheTtlMs, stateCacheNow)
    : undefined;

  async function pushOne(commit: ProjectionWorkerCommit): Promise<ProjectionWorkerPushResult> {
    const metadata = normalizeMetadata(commit.metadata);
    const laneKeys = uniqueLaneKeys(commit);
    const schedulingKeys = laneKeys.length > 0 ? laneKeys : [fallbackLaneKey(commit)];
    const decision = await lanes.run(schedulingKeys, async () => {
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
      const batchMode = determineBatchMode(options, commit.definition);

      return {
        index,
        commit,
        metadata,
        laneKeys,
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

    const resultItems = new Array<ProjectionWorkerResultItem>(commits.length);
    const laneRuns = nonAllEntries.map(async (entry) => {
      const schedulingKeys = entry.laneKeys.length > 0 ? entry.laneKeys : [fallbackLaneKey(entry.commit)];
      return lanes.run(schedulingKeys, async () => {
        const decisions = await processBatch(
          processor,
          entry.batchMode === 'none' ? undefined : options.batchProcessor,
          [entry.commit],
          [entry.metadata],
          [entry.laneKeys],
          options.stateLoader,
          stateCache
        );
        resultItems[entry.index] = toResultItem(entry.commit, entry.metadata, decisions[0] as ProjectionWorkerDecision);
      });
    });

    const allRuns = Array.from(allByProjection.values()).map(async (projectionEntries) => {
      const laneKeys = Array.from(new Set(projectionEntries.flatMap((entry) =>
        entry.laneKeys.length > 0 ? entry.laneKeys : [fallbackLaneKey(entry.commit)]))).sort();
      await lanes.run(laneKeys, async () => {
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
