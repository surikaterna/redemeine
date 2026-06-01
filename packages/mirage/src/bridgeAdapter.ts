interface BridgeableAggregateTypes {
    commands: Record<string, string>;
    events: Record<string, string>;
}

// Replicate demeine's string utilities
const camelCase = (str: string): string =>
    str.replace(/_([a-z])/g, (g) => g[1]!.toUpperCase());

export const capitalize = (str: string): string =>
    `${str.charAt(0).toUpperCase()}${str.slice(1)}`;

/**
 * Derives the processXxx method name from a command type string,
 * replicating demeine's DefaultCommandHandler._extractKey algorithm.
 */
export function extractCommandKey(type: string): string {
    const parts = type.split('.');
    const filteredParts: string[] = [];
    for (let i = 1; i < parts.length - 1; i++) {
        filteredParts.push(parts[i]!);
    }
    filteredParts.unshift(filteredParts.pop()!);
    return camelCase(filteredParts.join('_'));
}

/**
 * Derives the applyXxx method name from an event type string,
 * replicating demeine's DefaultEventHandler._extractKey algorithm.
 */
export function extractEventKey(type: string): string {
    const parts = type.split('.');
    const filteredParts: string[] = [];
    for (let i = 1; i < parts.length - 1; i++) {
        filteredParts.push(parts[i]!);
    }
    return camelCase(filteredParts.join('_'));
}

export function deriveAggregateType(builder: { types: BridgeableAggregateTypes }): string {
    const allTypes = {
        ...builder.types.commands,
        ...builder.types.events
    };
    const firstType = Object.values(allTypes)[0];
    if (!firstType) return 'unknown';
    return firstType.split('.')[0]!;
}

/**
 * Pre-computes command method name → command type mapping.
 */
export function buildCommandMethodMap(commands: Record<string, string>): Map<string, string> {
    const map = new Map<string, string>();
    for (const [, typeStr] of Object.entries(commands)) {
        const methodName = `process${capitalize(extractCommandKey(typeStr))}`;
        map.set(methodName, typeStr);
    }
    return map;
}

/**
 * Pre-computes event method name → event type mapping.
 */
export function buildEventMethodMap(events: Record<string, string>): Map<string, string> {
    const map = new Map<string, string>();
    for (const [, typeStr] of Object.entries(events)) {
        const methodName = `apply${capitalize(extractEventKey(typeStr))}`;
        map.set(methodName, typeStr);
    }
    return map;
}
