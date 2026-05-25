import type { Event, EventInterceptorContext, RedemeinePlugin } from '@redemeine/kernel';
import type { BuiltAggregate } from '@redemeine/aggregate';
import type { HydrationEvents } from './mirage.types';
import { assertPluginHasKey, hasHydrateEventPlugins, wrapPluginHookFailure } from './MirageCore';

/**
 * Maximum number of replayed hydration events before yielding back to the Node.js event loop.
 */
export const HYDRATION_REPLAY_YIELD_THRESHOLD = 250;

const yieldToEventLoop = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
};

export const hydrateStateFromEvents = async <S>(
    builder: BuiltAggregate<S, any, any, any>,
    aggregateId: string,
    baseState: S,
    events: HydrationEvents<Event>,
    plugins: RedemeinePlugin<any>[]
): Promise<S> => {
    let state = baseState;
    let replayedEvents = 0;
    const eventMetaRegistry = builder.metadata?.events || {};
    const hasHydratePlugins = hasHydrateEventPlugins(plugins);

    for await (const event of events) {
        if (hasHydratePlugins) {
            const ctx: EventInterceptorContext<{}, unknown> = {
                pluginKey: '',
                aggregateId,
                eventType: event.type,
                payload: event.payload,
                meta: eventMetaRegistry[event.type]?.meta
            };

            for (const plugin of plugins) {
                assertPluginHasKey(plugin);
                if (typeof plugin.onHydrateEvent === 'function') {
                    ctx.pluginKey = plugin.key;
                    try {
                        const nextPayload = await plugin.onHydrateEvent(ctx);
                        if (nextPayload !== undefined) {
                            ctx.payload = nextPayload;
                        }
                    } catch (error) {
                        throw wrapPluginHookFailure(plugin, 'onHydrateEvent', aggregateId, error);
                    }
                }
            }

            event.payload = ctx.payload;
        }

        state = builder.apply(state, event);
        replayedEvents++;

        if (replayedEvents % HYDRATION_REPLAY_YIELD_THRESHOLD === 0) {
            await yieldToEventLoop();
        }
    }

    return state;
};
