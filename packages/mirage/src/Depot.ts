import { Mirage, createMirage, MirageOptions, BuiltAggregate, MirageCoreSymbol, HydrationEvents } from './createMirage';
import {
  Event,
  EventInterceptorContext,
  PluginExtensions,
  RedemeinePlugin,
  RedemeinePluginHookError,
  emitCanonicalInspection,
  resolveInspectionCausationId,
  resolveInspectionCorrelationId
} from '@redemeine/kernel';

export interface EventStore {
    readStream(id: string, options?: EventReadStreamOptions): AsyncIterable<Event>;
    saveEvents(id: string, events: Event[], expectedVersion?: number): Promise<void>;
}

export type OutboxQueueEntry = {
  type: 'plugin.onAfterCommit';
  aggregateId: string;
  pluginKey: string;
  events: Event[];
  intents: Record<string, unknown>;
};

export interface OutboxCapableEventStore extends EventStore {
  saveEventsWithOutbox(args: {
    id: string;
    events: Event[];
    expectedVersion?: number;
    outbox: OutboxQueueEntry[];
  }): Promise<void>;
}

export type EventReadStreamOptions = {
  fromVersion?: number;
};

export type DepotSnapshot<TState> = {
  state: TState;
  version: number;
};

export type DepotGetOptions<TState> = {
  initialState?: TState;
  snapshot?: DepotSnapshot<TState>;
};

export type DepotOutboxOptions = {
  /**
   * outbox_primary: prefer atomic event+outbox persistence and never run inline side-effects
   * unless allowInlineAfterCommitFallback is explicitly enabled for non-capable stores.
   *
   * compatibility_inline: preserve legacy save-then-inline onAfterCommit behavior.
   */
  mode?: 'outbox_primary' | 'compatibility_inline';
};

type BuiltAggregateCommands<T> = T extends BuiltAggregate<any, infer M, any, any> ? M : Record<string, any>;
type BuiltAggregateState<T> = T extends BuiltAggregate<infer S, any, any, any> ? S : never;
type BuiltAggregateRegistry<T> = T extends BuiltAggregate<any, any, any, infer R> ? R : {};
type BuiltAggregatePlugins<T> = T extends BuiltAggregate<any, any, any, any, any, infer P> ? P : {};

/**
 * Depots are the primary way to retrieve a Mirage of an aggregate by its ID.
 * Handles event sourced hydration and persistence of new uncommitted events.
 */
export interface Depot<TState extends {}, M extends Record<string, any> = any, Registry extends Record<string, any> = {}> {
  get(id: string, options?: DepotGetOptions<TState>): Promise<Mirage<TState, M, Registry>>;
  save(mirage: Mirage<TState, M, Registry>): Promise<void>;
}

/**
 * Creates a standard Depot linking an EventStore to a BuiltAggregate.
 */
export function createDepot<BA extends BuiltAggregate<any, any, any, any>>(
  builder: BA,
  store: EventStore,
  options?: MirageOptions<BuiltAggregatePlugins<BA>> & {
    outbox?: DepotOutboxOptions;
  }
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
          await emitCanonicalInspection(options?.inspection, {
            hook: 'event.append',
            runtime: 'mirage',
            boundary: 'event_store.append',
            ids: {
              aggregateId: id,
              eventType: event.type,
              correlationId: resolveInspectionCorrelationId(event.metadata?.correlationId, `${id}:${event.type}:event.append`),
              causationId: resolveInspectionCausationId(event.id, event.type),
              eventId: resolveInspectionCausationId(event.id)
            },
            payload: {
              pluginKey: plugin.key,
              eventType: event.type
            },
            compatibility: {
              legacyHook: 'onBeforeAppend',
              legacyContext: {
                aggregateId: id,
                eventType: event.type,
                pluginKey: plugin.key
              }
            }
          });
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
        await emitCanonicalInspection(options?.inspection, {
          hook: 'outbox.enqueue',
          runtime: 'mirage',
          boundary: 'post_commit.side_effect',
          ids: {
            aggregateId: id,
            correlationId: resolveInspectionCorrelationId((events[0]?.metadata as Record<string, unknown> | undefined)?.correlationId, `${id}:outbox.enqueue`),
            causationId: resolveInspectionCausationId(events[0]?.id)
          },
          payload: {
            pluginKey: plugin.key,
            eventCount: events.length,
            intentKeys: Object.keys(intents)
          },
          compatibility: {
            legacyHook: 'onAfterCommit',
            legacyContext: {
              aggregateId: id,
              events: events.map((event) => event.type),
              pluginKey: plugin.key
            }
          }
        });
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

  const hasOutboxCapability = (candidate: EventStore): candidate is OutboxCapableEventStore => {
    return typeof (candidate as OutboxCapableEventStore).saveEventsWithOutbox === 'function';
  };

  const buildOutboxEntries = (
    id: string,
    events: Event[],
    intents: Record<string, unknown>
  ): OutboxQueueEntry[] => {
    return plugins
      .filter((plugin): plugin is Required<Pick<RedemeinePlugin<any>, 'key' | 'onAfterCommit'>> & RedemeinePlugin<any> => typeof plugin.onAfterCommit === 'function')
      .map((plugin) => ({
        type: 'plugin.onAfterCommit' as const,
        aggregateId: id,
        pluginKey: plugin.key,
        events,
        intents
      }));
  };

  return {
      get: async (id: string, getOptions?: DepotGetOptions<BuiltAggregateState<BA>>) => {
          const snapshot = getOptions?.snapshot;
          const initialState = getOptions?.initialState;

          if (snapshot) {
            const events = store.readStream(id, { fromVersion: snapshot.version + 1 });
            return createMirage(builder, id, { ...options, snapshot: snapshot.state, events });
          }

          if (initialState !== undefined) {
            const events = store.readStream(id);
            return createMirage(builder, id, { ...options, snapshot: initialState, events });
          }

          const events = store.readStream(id);
          return createMirage(builder, id, { ...options, events });
      },
      save: async (mirage: Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>>) => {
        const core = (mirage as any)[MirageCoreSymbol];
        if (!core) throw new Error('Not a valid Mirage Instance');

          const { events, intents } = core.getPendingResults();
          const appendableEvents = await runAppendInterceptors(core.id, events);

          const outboxMode = options?.outbox?.mode ?? 'compatibility_inline';
          const outboxEntries = buildOutboxEntries(core.id, appendableEvents, intents);

          if (outboxMode === 'outbox_primary' && outboxEntries.length > 0) {
            if (hasOutboxCapability(store)) {
              await store.saveEventsWithOutbox({
                id: core.id,
                events: appendableEvents,
                expectedVersion: core.version,
                outbox: outboxEntries
              });
              core.clearPendingResults();
              return;
            }

            throw new Error(
              'Outbox primary mode requires an EventStore implementing saveEventsWithOutbox. ' +
              'Use options.outbox.mode="compatibility_inline" for explicit legacy inline compatibility mode.'
            );
          }

          await store.saveEvents(core.id, appendableEvents, core.version);
          core.clearPendingResults();

          await runAfterCommitHooks(core.id, appendableEvents, intents);
      }
  };
}
