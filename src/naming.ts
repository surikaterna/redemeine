import { EventType } from './types';

export const formatCommandType = (aggregateName: string, prop: string) => aggregateName + '.' + prop + '.command';

export const formatFlatEventType = (aggregateName: string, prop: string) => (aggregateName + '.' + prop + '.event') as EventType;

export const formatTargetedEventType = (aggregateName: string, prop: string): EventType => {
    const parts = prop.split(/(?=[A-Z])/);
    if (parts.length > 1) {
        const entities = parts.slice(0, parts.length - 1);
        const action = parts[parts.length - 1];
        const actionName = action.charAt(0).toLowerCase() + action.slice(1);
        const path = entities.map(e => e.toLowerCase()).join('.');
        return (aggregateName + '.' + path + '.' + actionName + '.event') as EventType;
    }
    return formatFlatEventType(aggregateName, prop);
}

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
