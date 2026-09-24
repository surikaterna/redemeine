import type {
  ProjectionDefinitionLike,
  ProjectionWorkerCommit,
  ProjectionWorkerProjectionStateAccess,
  ProjectionWorkerStateLoader,
  ProjectionWorkerStateRequest
} from './contracts';

export interface ProjectionStateCache {
  get(key: string): unknown | null | undefined;
  set(key: string, value: unknown | null): void;
  delete(key: string): void;
}

const computeStateKey = (definition: ProjectionDefinitionLike, targetId: string): string =>
  `${definition.projectionName}:${targetId}`;

export function readPositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : undefined;
}

export function createLruCache(maxEntries: number, ttlMs: number, now: () => number): ProjectionStateCache {
  const entries = new Map<string, { value: unknown | null; expiresAt: number }>();
  const prune = (): void => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt > current) break;
      entries.delete(key);
    }
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      const current = now();
      if (entry.expiresAt <= current) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, { value: entry.value, expiresAt: current + ttlMs });
      return entry.value;
    },
    set(key, value) {
      prune();
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (typeof oldest !== 'string') break;
        entries.delete(oldest);
      }
    },
    delete(key) {
      entries.delete(key);
    }
  };
}

export function createProjectionStateAccess(
  commit: ProjectionWorkerCommit,
  stateLoader: ProjectionWorkerStateLoader | undefined,
  stateCache: ProjectionStateCache | undefined
): ProjectionWorkerProjectionStateAccess {
  const loaded = new Map<string, unknown | null>();
  const loadState = async (targetId: string): Promise<unknown | null> => {
    if (loaded.has(targetId)) return loaded.get(targetId) ?? null;
    const key = computeStateKey(commit.definition, targetId);
    const cached = stateCache?.get(key);
    if (cached !== undefined) {
      loaded.set(targetId, cached);
      return cached;
    }
    const request: ProjectionWorkerStateRequest = {
      definition: commit.definition,
      projectionName: commit.definition.projectionName,
      targetId
    };
    const value = (stateLoader === undefined ? null : await stateLoader(request)) ?? null;
    loaded.set(targetId, value);
    stateCache?.set(key, value);
    return value;
  };
  return {
    getProjectionState: loadState,
    setProjectionState(targetId, state) {
      const value = state ?? null;
      loaded.set(targetId, value);
      stateCache?.set(computeStateKey(commit.definition, targetId), value);
    },
    evictProjectionState(targetId) {
      loaded.delete(targetId);
      stateCache?.delete(computeStateKey(commit.definition, targetId));
    }
  };
}

export function evictStateCacheTargets(
  stateCache: ProjectionStateCache | undefined,
  commit: ProjectionWorkerCommit
): void {
  if (!stateCache) return;
  const targets = new Set(commit.message.routeDecision.targets.map((target) => target.targetId));
  if (targets.size === 0) targets.add(commit.message.envelope.sourceId);
  for (const targetId of targets) stateCache.delete(computeStateKey(commit.definition, targetId));
}
