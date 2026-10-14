import type { Event, ReadonlyDeep } from '@redemeine/kernel';
import { createMirage } from './createMirage';
import type { MirageOptions, BuiltAggregateState, BuiltAggregatePlugins, MirageOf, NoMirageCollisions } from './mirage.types';
import { getCore } from './coreAccess';
import { builderPlugins, erasePlugins, readProperty, type MirageBuilder } from './runtimeDefinition';
import { assertEventCount, assertPluginHasKey } from './MirageCore';
import { beforeAppend, afterCommit } from './depotPlugins';

export interface EventStore {
  readStream(id: string, options?: EventReadStreamOptions): AsyncIterable<Event>;
  /** Expected persisted event count BEFORE this append (zero for a new stream). */
  saveEvents(id: string, events: Event[], expectedVersion?: number): Promise<void>;
}
export type EventReadStreamOptions = { fromVersion?: number };
export type DepotSnapshot<TState> = { state: TState | ReadonlyDeep<TState>; version: number };
export type DepotGetOptions<TState> = { initialState?: TState | ReadonlyDeep<TState>; snapshot?: DepotSnapshot<TState> };

export interface Depot<B extends MirageBuilder> {
  get(id: string, options?: DepotGetOptions<BuiltAggregateState<B>>): Promise<MirageOf<B>>;
  save(mirage: MirageOf<B>): Promise<void>;
}

export function createDepot<B extends MirageBuilder>(builder: B & NoMirageCollisions<NoInfer<B>>, store: EventStore,
  options?: MirageOptions<BuiltAggregatePlugins<B>>): Depot<B> {
  const plugins = [...builderPlugins(builder), ...erasePlugins(options?.plugins ?? [])];
  plugins.forEach(assertPluginHasKey);
  return {
    async get(id, setup) {
      if (setup?.snapshot) {
        const snapshot = setup.snapshot;
        assertEventCount(snapshot.version);
        const events = store.readStream(id, { fromVersion: snapshot.version + 1 });
        return createMirage<B>(builder, id, { ...options, snapshot: snapshot.state, initialVersion: snapshot.version, events });
      }
      const events = store.readStream(id);
      return setup?.initialState === undefined ? createMirage<B>(builder, id, { ...options, events })
        : createMirage<B>(builder, id, { ...options, snapshot: setup.initialState, events });
    },
    async save(mirage) {
      const core = getCore<BuiltAggregateState<B>>(mirage);
      if (!Object.is(core.builder, builder)) throw new Error('Mirage belongs to a different builder');
      const { events, intents } = core.getPendingResults();
      const expectedVersion = core.version - events.length;
      const appendable = await beforeAppend(core.id, events, plugins, readProperty(builder, 'metadata'));
      await store.saveEvents(core.id, appendable, expectedVersion);
      core.clearPendingResults();
      // Post-commit effects are not rolled back; transactional outbox behavior is a separate contract.
      await afterCommit(core.id, appendable, intents, plugins);
    }
  };
}
