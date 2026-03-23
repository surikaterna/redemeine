import { createEvent } from '../createEvent';
import { NamingStrategy } from '../types';

export function createEmitProxy(
    aggregateName: string,
    allEventOverrides: Record<string, string>,
    namingStrategy: NamingStrategy
) {
    return new Proxy({} as any, {
        get: (_, prop: string) => {
            const type = allEventOverrides[prop] || namingStrategy.event(aggregateName, prop);
            return createEvent(type);
        }
    });
}
