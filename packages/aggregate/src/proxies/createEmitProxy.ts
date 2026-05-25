import { createEvent, type NamingStrategy } from '@redemeine/kernel';

export function createEmitProxy(
    aggregateName: string,
    allEventOverrides: Record<string, string>,
    namingStrategy: NamingStrategy,
    path?: string
) {
    // SAFETY: Proxy target is never accessed directly; all property access goes through the get trap
    return new Proxy({} as Record<string, unknown>, {
        get: (_, prop: string) => {
            const scopedKey = path ? `${path}:${prop}` : prop;
            const type = allEventOverrides[scopedKey] || allEventOverrides[prop] || namingStrategy.event(aggregateName, prop, path);
            return createEvent(type);
        }
    });
}
