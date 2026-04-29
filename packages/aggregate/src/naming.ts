import type { EventType, NamingStrategy } from '@redemeine/kernel';

export const toSnakeCase = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Converts snake_case to camelCase (e.g., 'order_lines' → 'orderLines') */
export const toCamelCase = (value: string): string => 
    value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Naive singularization — strips trailing 's'. Works for regular English plurals. */
export const singular = (value: string): string => 
    value.endsWith('s') ? value.slice(0, -1) : value;

export const formatCommandType = (aggregateName: string, prop: string, path?: string) => {
    const commandName = toSnakeCase(prop);
    if (path) return `${aggregateName}.${path}.${commandName}.command`;
    return aggregateName + '.' + commandName + '.command';
};

export const formatFlatEventType = (aggregateName: string, prop: string, path?: string) => {
    if (path) return `${aggregateName}.${path}.${prop}.event` as EventType;
    return (aggregateName + '.' + prop + '.event') as EventType;
};

export const formatTargetedEventType = (aggregateName: string, prop: string, path?: string): EventType => {
    if (path) {
        return formatFlatEventType(aggregateName, toSnakeCase(prop), path);
    }
    const parts = prop.split(/(?=[A-Z])/);
    if (parts.length > 1) {
        const entities = parts.slice(0, parts.length - 1);
        const action = parts[parts.length - 1];
        const actionName = action.charAt(0).toLowerCase() + action.slice(1);
        const autoPath = entities.map(e => e.toLowerCase()).join('.');
        return (aggregateName + '.' + autoPath + '.' + actionName + '.event') as EventType;
    }
    return formatFlatEventType(aggregateName, prop);
}

export const defaultNamingStrategy: NamingStrategy = {
    command: formatCommandType,
    event: formatTargetedEventType
};

export const formatSnakeCaseEventType = (aggregateName: string, prop: string, path?: string): EventType => {
    const eventName = toSnakeCase(prop);
    if (path) return `${aggregateName}.${path}.${eventName}.event` as EventType;
    return `${aggregateName}.${eventName}.event` as EventType;
};

/** Predefined naming strategy presets for common conventions */
export const namingStrategies = {
    /** Default: commands use snake_case, events use targeted dot-notation path splitting */
    targeted: defaultNamingStrategy,
    /** Flat with snake_case for both commands and events — matches legacy demeine conventions */
    snakeCase: {
        command: formatCommandType,
        event: formatSnakeCaseEventType,
    } as NamingStrategy,
    /** Flat with no case conversion — preserves camelCase prop names verbatim */
    flat: {
        command: formatCommandType,
        event: formatFlatEventType,
    } as NamingStrategy,
} as const;

export const parseTargetedEventPath = (eventType: string, aggregateName: string) => {
    const prefix = aggregateName + '.';
    if (eventType.startsWith(prefix) && eventType.endsWith('.event')) {
        const withoutSuffix = eventType.slice(0, -6); // remove .event
        const parts = withoutSuffix.slice(prefix.length).split('.');
        
        if (parts.length > 1) {
            const actionName = parts.pop()!;
            return { 
                parts, 
                actionName, 
                coreEventName: formatFlatEventType(aggregateName, actionName) 
            };
        }
    }
    return null;
}
