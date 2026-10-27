/** Registration dictionaries contain declared own keys, never inherited object methods. */
export function ownDefinition<T>(definitions: Record<string, T>, key: string): T | undefined {
    return Object.hasOwn(definitions, key) ? definitions[key] : undefined;
}
