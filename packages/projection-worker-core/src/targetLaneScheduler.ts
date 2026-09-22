type Lane = { tail: Promise<void> };

export interface ProjectionLaneScheduler {
  run<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T>;
}

export function createProjectionLaneScheduler(): ProjectionLaneScheduler {
  const lanes = new Map<string, Lane>();
  const getLane = (key: string): Lane => {
    const existing = lanes.get(key);
    if (existing) return existing;
    const created = { tail: Promise.resolve() };
    lanes.set(key, created);
    return created;
  };

  return {
    run<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
      const canonicalKeys = [...new Set(keys)].sort();
      const previous: Promise<void>[] = [];
      const releases: Array<() => void> = [];
      for (const key of canonicalKeys) {
        const lane = getLane(key);
        previous.push(lane.tail);
        lane.tail = new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      }
      return Promise.all(previous).then(operation).finally(() => {
        for (const release of releases) release();
      });
    }
  };
}
