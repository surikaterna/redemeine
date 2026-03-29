import { Mirage, createMirage, MirageOptions, BuiltAggregate, MirageCoreSymbol, HydrationEvents } from './createMirage';
import { Event, EventInterceptorContext, PluginExtensions, RedemeinePlugin, RedemeinePluginHookError } from './types';

export interface EventStore {
    getEvents(id: string): HydrationEvents<Event> | Promise<HydrationEvents<Event>>;
    saveEvents(id: string, events: Event[], expectedVersion?: number): Promise<void>;
}

type BuiltAggregateCommands<T> = T extends BuiltAggregate<any, infer M, any, any> ? M : Record<string, any>;
type BuiltAggregateState<T> = T extends BuiltAggregate<infer S, any, any, any> ? S : never;
type BuiltAggregateRegistry<T> = T extends BuiltAggregate<any, any, any, infer R> ? R : {};
type BuiltAggregatePlugins<T> = T extends BuiltAggregate<any, any, any, any, any, infer P> ? P : {};

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
  options?: MirageOptions<BuiltAggregatePlugins<BA>>
): Depot<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>> {
  const plugins = [...(builder.plugins || []), ...(options?.plugins || [])] as RedemeinePlugin<any>[];

  const assertPluginHasKey = (plugin: RedemeinePlugin<any>): void => {
    if (!plugin.key || typeof plugin.key !== 'string') {
      throw new Error('Invalid plugin configuration: plugin.key is required and must be a non-empty string.');
    }
  };

  plugins.forEach(assertPluginHasKey);

  const wrapPluginHookFailure = (
    plugin: RedemeinePlugin<any>,
    hook: 'onBeforeAppend' | 'onAfterCommit',
    aggregateId: string,
    cause: unknown
  ): RedemeinePluginHookError => {
    return new RedemeinePluginHookError({
      pluginKey: plugin.key,
      hook,
      aggregateId,
      cause
    });
  };

  const runAppendInterceptors = async (id: string, events: Event[]): Promise<Event[]> => {
    if (plugins.length === 0) return events;

    const eventMetaRegistry = builder.metadata?.events || {};

    for (const event of events) {
      const ctx: EventInterceptorContext<{}, unknown> = {
        pluginKey: '',
        aggregateId: id,
        eventType: event.type,
        payload: event.payload,
        meta: eventMetaRegistry[event.type]?.meta
      };

      for (const plugin of plugins) {
        if (typeof plugin.onBeforeAppend === 'function') {
          ctx.pluginKey = plugin.key;
          try {
            const nextPayload = await plugin.onBeforeAppend(ctx);
            if (nextPayload !== undefined) {
              ctx.payload = nextPayload;
            }
          } catch (error) {
            throw wrapPluginHookFailure(plugin, 'onBeforeAppend', id, error);
          }
        }
      }

      event.payload = ctx.payload;
    }

    return events;
  };

  const runAfterCommitHooks = async (
    id: string,
    events: Event[],
    intents: Record<string, unknown>
  ): Promise<void> => {
    if (plugins.length === 0) return;

    for (const plugin of plugins) {
      if (typeof plugin.onAfterCommit === 'function') {
        try {
          await plugin.onAfterCommit({
            pluginKey: plugin.key,
            aggregateId: id,
            events,
            intents
          });
        } catch (error) {
          throw wrapPluginHookFailure(plugin, 'onAfterCommit', id, error);
        }
      }
    }
  };

  return {
      get: async (id: string) => {
          const events = await store.getEvents(id);
          return createMirage(builder, id, { ...options, events });
      },
      save: async (mirage: Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>>) => {
        const core = (mirage as any)[MirageCoreSymbol];
        if (!core) throw new Error('Not a valid Mirage Instance');

          const { events, intents } = core.getPendingResults();
          const appendableEvents = await runAppendInterceptors(core.id, events);

          await store.saveEvents(core.id, appendableEvents, core.version);
          core.clearPendingResults();

          // TODO(outbox): move onAfterCommit side-effects to a transactional outbox worker
          // so post-commit failures are retriable without coupling to request lifecycle.
          await runAfterCommitHooks(core.id, appendableEvents, intents);
      }
  };
}
