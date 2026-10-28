import { mergeDefinitions } from './entityCommandTarget';

// Reassignment order cannot be recovered from Object.keys on flattened components.
// Keep it on the registration map, not on reusable projector functions or grouped mounts.
const assignmentOrder = new WeakMap<object, string[]>();

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
    for (const key of keys) recordEventAssignment(destination, key);
    return destination;
}
