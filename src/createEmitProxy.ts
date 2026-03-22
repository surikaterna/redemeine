import { createEvent } from './createEvent';
import { formatTargetedEventType } from './naming';

export function createEmitProxy(
    aggregateName: string,
    allEventOverrides: Record<string, string>
) {
    return new Proxy({} as any, {
        get: (_, prop: string) => {
            const type = allEventOverrides[prop] || formatTargetedEventType(aggregateName, prop);
            return createEvent(type);
        }
    });
}
