import { Mirage, createMirage, MirageOptions, BuiltAggregate, MirageCoreSymbol } from './createMirage';
import { Event } from './types';

export interface EventStore {
    getEvents(id: string): Promise<Event[]>;
    saveEvents(id: string, events: Event[], expectedVersion?: number): Promise<void>;
}

type BuiltAggregateCommands<T> = T extends BuiltAggregate<any, infer M, any, any> ? M : Record<string, any>;
type BuiltAggregateState<T> = T extends BuiltAggregate<infer S, any, any, any> ? S : never;
type BuiltAggregateRegistry<T> = T extends BuiltAggregate<any, any, any, infer R> ? R : {};

/**
 * Depots are the primary way to retrieve a Mirage of an aggregate by its ID.
 * Handles event sourced hydration and persistence of new uncommitted events.
 */
export interface Depot<TState extends {}, M extends Record<string, any> = any, Registry extends Record<string, any> = {}> {
  get(id: string): Promise<Mirage<TState, M, Registry>>;
  save(mirage: Mirage<TState, M, Registry>): Promise<void>;
}

/**
 * Creates a standard Depot linking an EventStore to a BuiltAggregate.
 */
export function createDepot<BA extends BuiltAggregate<any, any, any, any>>(
  builder: BA,
  store: EventStore,
  options?: MirageOptions
): Depot<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>> {
  return {
      get: async (id: string) => {
          const events = await store.getEvents(id);
        return createMirage(builder, id, { ...options, events });
      },
      save: async (mirage: Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>>) => {
          const core = (mirage as any)[MirageCoreSymbol];
          if (!core) throw new Error('Not a valid Mirage Instance');
          await store.saveEvents(core.id, core.uncommitted, core.version);
          core.uncommitted = [];
      }
  };
}
