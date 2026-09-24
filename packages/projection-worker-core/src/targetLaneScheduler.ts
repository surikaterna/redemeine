type Lane = { tail: Promise<void>; pending: number };
type Reservation = { key: string; lane: Lane; previous: Promise<void>; release: () => void };

export interface ProjectionLaneScheduler {
  run<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T>;
}

const schedulerLanes = new WeakMap<ProjectionLaneScheduler, ReadonlyMap<string, Lane>>();

export function observeProjectionLaneCountForTest(scheduler: ProjectionLaneScheduler): number {
  const lanes = schedulerLanes.get(scheduler);
  if (!lanes) throw new Error('Unknown projection lane scheduler');
  return lanes.size;
}

export function createProjectionLaneScheduler(): ProjectionLaneScheduler {
  const lanes = new Map<string, Lane>();
  const getLane = (key: string): Lane => {
    const existing = lanes.get(key);
    if (existing) return existing;
    const created = { tail: Promise.resolve(), pending: 0 };
    lanes.set(key, created);
    return created;
  };

  const reserve = (key: string): Reservation => {
    const lane = getLane(key);
    const previous = lane.tail;
    let release = (): void => undefined;
    lane.pending += 1;
    lane.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { key, lane, previous, release };
  };

  const release = (reservations: readonly Reservation[]): void => {
    for (const reservation of reservations) {
      reservation.lane.pending -= 1;
      reservation.release();
      if (reservation.lane.pending === 0 && lanes.get(reservation.key) === reservation.lane) {
        lanes.delete(reservation.key);
      }
    }
  };

  const scheduler: ProjectionLaneScheduler = {
    run<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
      const canonicalKeys = [...new Set(keys)].sort();
      const reservations = canonicalKeys.map(reserve);
      return Promise.all(reservations.map((reservation) => reservation.previous))
        .then(operation)
        .finally(() => release(reservations));
    }
  };
  schedulerLanes.set(scheduler, lanes);
  return scheduler;
}
