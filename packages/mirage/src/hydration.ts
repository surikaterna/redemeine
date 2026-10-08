import type { Event, EventInterceptorContext, RedemeinePlugin } from '@redemeine/kernel';
import type { BuiltAggregate } from '@redemeine/aggregate';
import type { HydrationEvents } from './mirage.types';
import { assertCanAdvanceEventCount, assertPluginHasKey, hasHydrateEventPlugins, wrapPluginHookFailure } from './MirageCore';

/**
 * Maximum number of replayed hydration events before yielding back to the Node.js event loop.
 */
export const HYDRATION_REPLAY_YIELD_THRESHOLD = 250;

const yieldToEventLoop = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
};

const runHydratePlugins = async (
    ctx: EventInterceptorContext<{}, unknown>,
    plugins: RedemeinePlugin[]
): Promise<void> => {
    for (const plugin of plugins) {
        assertPluginHasKey(plugin);
        if (typeof plugin.onHydrateEvent !== 'function') continue;
        ctx.pluginKey = plugin.key;
        try {
            const nextPayload = await plugin.onHydrateEvent(ctx);
            if (nextPayload !== undefined) ctx.payload = nextPayload;
        } catch (error) {
            throw wrapPluginHookFailure(plugin, 'onHydrateEvent', ctx.aggregateId, error);
        }
    }
};

export const hydrateStateFromEvents = async <S>(
    builder: BuiltAggregate<S, any, any, any>,
    aggregateId: string,
    baseState: S,
    events: HydrationEvents<Event>,
    plugins: RedemeinePlugin<any>[],
    initialVersion: number
): Promise<{ state: S; appliedCount: number }> => {
    let state = baseState;
    let replayedEvents = 0;
    const eventMetaRegistry = builder.metadata?.events || {};
    const hasHydratePlugins = hasHydrateEventPlugins(plugins);

    for await (const event of events) {
        assertCanAdvanceEventCount(initialVersion + replayedEvents);
        if (hasHydratePlugins) {
            const ctx: EventInterceptorContext<{}, unknown> = {
                pluginKey: '',
                aggregateId,
                eventType: event.type,
                payload: event.payload,
                meta: eventMetaRegistry[event.type]?.meta
            };

            await runHydratePlugins(ctx, plugins);

            event.payload = ctx.payload;
        }

        state = builder.apply(state, event);
        replayedEvents++;

        if (replayedEvents % HYDRATION_REPLAY_YIELD_THRESHOLD === 0) {
            await yieldToEventLoop();
        }
    }

    return { state, appliedCount: replayedEvents };
};
