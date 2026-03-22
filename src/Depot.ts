import { Mirage, createMirage, MirageOptions, BuiltAggregate, MirageCoreSymbol } from './createMirage';
import { Event } from './types';

export interface EventStore {
    getEvents(id: string): Promise<Event[]>;
    saveEvents(id: string, events: Event[], expectedVersion?: number): Promise<void>;
}

/**
 * Depots are the primary way to retrieve a Mirage of an aggregate by its ID.
 * Handles event sourced hydration and persistence of new uncommitted events.
 */
export interface Depot<TState, M extends Record<string, any> = any> {
  get(id: string): Promise<Mirage<TState, M>>;
  save(mirage: Mirage<TState, M>): Promise<void>;
}

/**
 * Creates a standard Depot linking an EventStore to a BuiltAggregate.
 */
export function createDepot<TState, M extends Record<string, any>>(
  builder: BuiltAggregate<TState, M>,
  store: EventStore,
  options?: MirageOptions
): Depot<TState, M> {
  return {
      get: async (id: string) => {
          const events = await store.getEvents(id);
          return createMirage(builder, id, { ...options, events });
      },
      save: async (mirage: Mirage<TState, M>) => {
          const core = (mirage as any)[MirageCoreSymbol];
          if (!core) throw new Error('Not a valid Mirage Instance');
          await store.saveEvents(core.id, core.uncommitted, core.version);
          core.uncommitted = [];
      }
  };
}
