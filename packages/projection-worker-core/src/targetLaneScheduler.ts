type Lane = { tail: Promise<void>; pending: number };
type Reservation = { key: string; lane: Lane; previous: Promise<void>; release: () => void };

export interface ProjectionLaneScheduler {
  readonly size: number;
  run<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T>;
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

  return {
    get size(): number {
      return lanes.size;
    },
    run<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
      const canonicalKeys = [...new Set(keys)].sort();
      const reservations = canonicalKeys.map(reserve);
      return Promise.all(reservations.map((reservation) => reservation.previous))
        .then(operation)
        .finally(() => release(reservations));
    }
  };
}
