import { EventType, NamingStrategy } from '../types';

export const formatCommandType = (aggregateName: string, prop: string, path?: string) => {
    if (path) return `${aggregateName}.${path}.${prop}.command`;
    return aggregateName + '.' + prop + '.command';
};

export const formatFlatEventType = (aggregateName: string, prop: string, path?: string) => {
    if (path) return `${aggregateName}.${path}.${prop}.event` as EventType;
    return (aggregateName + '.' + prop + '.event') as EventType;
};

export const formatTargetedEventType = (aggregateName: string, prop: string, path?: string): EventType => {
    if (path) {
        return formatFlatEventType(aggregateName, prop, path);
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
