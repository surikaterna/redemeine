import { createEvent } from './createEvent';

export function createEmitProxy(
    aggregateName: string,
    allEventOverrides: Record<string, string>
) {
    return new Proxy({} as any, {
        get: (_, prop: string) => {
            let type = allEventOverrides[prop];
            
            if (!type) {
                const parts = prop.split(/(?=[A-Z])/);
                if (parts.length > 1) {
                    const entities = parts.slice(0, parts.length - 1);
                    const action = parts[parts.length - 1];
                    const actionName = action.charAt(0).toLowerCase() + action.slice(1);
                    
                    const path = entities.map(e => e.toLowerCase()).join('.');
                    type = aggregateName + '.' + path + '.' + actionName + '.event';
                } else {
                    type = aggregateName + '.' + prop + '.event';
                }
            }

            return createEvent(type);
        }
    });
}
