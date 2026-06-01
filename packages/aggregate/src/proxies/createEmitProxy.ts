import { createEvent, type NamingStrategy } from '@redemeine/kernel';

export function createEmitProxy(
    aggregateName: string,
    allEventOverrides: Record<string, string>,
    namingStrategy: NamingStrategy,
    path?: string
) {
    // SAFETY: `any` required — Proxy target must be typed as `any` per JS Proxy handler spec
    return new Proxy({} as any, {
        get: (_, prop: string) => {
            const scopedKey = path ? `${path}:${prop}` : prop;
            const type = allEventOverrides[scopedKey] || allEventOverrides[prop] || namingStrategy.event(aggregateName, prop, path);
            return createEvent(type);
        }
    });
}
