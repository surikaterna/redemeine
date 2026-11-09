import { mergeDefinitions } from './entityCommandTarget';

// Reassignment order cannot be recovered from Object.keys on flattened components.
// Keep it on the registration map, not on reusable projector functions or grouped mounts.
const assignmentOrder = new WeakMap<object, string[]>();
export type EventOrigin = { segments: readonly string[]; declaration: object; member: string; ambiguous?: boolean; aliases?: readonly EventOrigin[] };
const origins = new WeakMap<object, Map<string, EventOrigin>>();

export function eventOrigin(definitions: Record<string, Function>, key: string): EventOrigin {
    return origins.get(definitions)?.get(key) ?? { segments: [key], declaration: definitions, member: key };
}

export function recordEventOrigin(destination: object, key: string, origin: EventOrigin): void {
    let records = origins.get(destination);
    if (!records) origins.set(destination, records = new Map());
    const previous = records.get(key);
    // Flattening may hide a declaration before the aggregate sees it. Keep aliases
    // and duplicate-ID evidence without changing which projector wins that key.
    const declarations = [...(previous ? [{ ...previous, aliases: [] }, ...(previous.aliases ?? [])] : []), ...(origin.aliases ?? [])];
    const sameId = declarations.filter(entry => entry.segments.join('.') === origin.segments.join('.'));
    const collision = sameId.some(entry => entry.segments.length === 1 || origin.segments.length === 1
        || entry.declaration !== origin.declaration || entry.member !== origin.member
        || JSON.stringify(entry.segments) !== JSON.stringify(origin.segments));
    records.set(key, { ...origin, segments: [...origin.segments],
        aliases: declarations, ambiguous: Boolean(origin.ambiguous || collision) });
}

export function scopeEventOrigin(origin: EventOrigin, segment: string): EventOrigin {
    return { ...origin, segments: [segment, ...origin.segments],
        ...(origin.aliases ? { aliases: origin.aliases.map(alias => scopeEventOrigin(alias, segment)) } : {}) };
}

export function eventDefinitionKeys(definitions: Record<string, Function>): string[] {
    return assignmentOrder.get(definitions) ?? Object.keys(definitions);
}

export function recordEventAssignment(definitions: Record<string, Function>, key: string): void {
    const order = eventDefinitionKeys(definitions).filter(previous => previous !== key);
    order.push(key);
    assignmentOrder.set(definitions, order);
}

export function mergeEventDefinitions(destination: Record<string, Function>, source: Record<string, Function>): Record<string, Function> {
    const keys = eventDefinitionKeys(source);
    mergeDefinitions(destination, source);
    for (const key of keys) {
        recordEventAssignment(destination, key);
        recordEventOrigin(destination, key, eventOrigin(source, key));
    }
    return destination;
}
