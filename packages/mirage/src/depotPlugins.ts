import type { Event, EventInterceptorContext } from '@redemeine/kernel';
import { wrapPluginHookFailure } from './MirageCore';
import { metadataFor, type RuntimeExtensions, type RuntimePlugin } from './runtimeDefinition';

export async function beforeAppend(id: string, events: Event[], plugins: RuntimePlugin[], metadata: unknown): Promise<Event[]> {
  if (!plugins.length) return events;
  for (const event of events) {
    const context: EventInterceptorContext<RuntimeExtensions> = {
      pluginKey: '', aggregateId: id, eventType: event.type, payload: event.payload, meta: metadataFor(metadata, event.type)
    };
    for (const plugin of plugins) {
      if (!plugin.onBeforeAppend) continue;
      context.pluginKey = plugin.key;
      try {
        const payload = await plugin.onBeforeAppend(context);
        if (payload !== undefined) context.payload = payload;
      } catch (error) {
        throw wrapPluginHookFailure(plugin, 'onBeforeAppend', id, error);
      }
    }
    event.payload = context.payload;
  }
  return events;
}

export async function afterCommit(id: string, events: Event[], intents: Record<string, unknown>, plugins: RuntimePlugin[]): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.onAfterCommit) continue;
    try {
      await plugin.onAfterCommit({ pluginKey: plugin.key, aggregateId: id, events, intents });
    } catch (error) {
      throw wrapPluginHookFailure(plugin, 'onAfterCommit', id, error);
    }
  }
}
