import { createEvent, NamingStrategy } from '@redemeine/kernel';

export function createEmitProxy(
    aggregateName: string,
    allEventOverrides: Record<string, string>,
    namingStrategy: NamingStrategy,
    path?: string
) {
    return new Proxy({} as any, {
        get: (_, prop: string) => {
            const scopedKey = path ? `${path}:${prop}` : prop;
            const type = allEventOverrides[scopedKey] || allEventOverrides[prop] || namingStrategy.event(aggregateName, prop, path);
            return createEvent(type);
        }
    });
}
