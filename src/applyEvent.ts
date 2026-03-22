import { produce } from 'immer';
import { Event } from './types';

export function applyEvent<S>(
    aggregateName: string,
    state: S,
    event: Event,
    allEvents: Record<string, Function>,
    allEventOverrides: Record<string, string>
): S {
    return produce(state, (draft: any) => {
        let targetDraft = draft;
        let eventTypeStr = event.type;
        
        // Parse targeted event: "aggregate.entity[id].subEntity[id2].eventName.event"
        const prefix = aggregateName + '.';
        let eventName = event.type;
        
        if (eventTypeStr.startsWith(prefix) && eventTypeStr.endsWith('.event')) {
            const withoutSuffix = eventTypeStr.slice(0, -6); // remove .event
            const parts = withoutSuffix.slice(prefix.length).split('.');
            
            if (parts.length > 1) {
                const actionName = parts.pop()!;
                
                // Drill down
                for (const part of parts) {
                    const arrayName = part;
                    // looking for ID from payload
                    const id = event.payload && (
                        event.payload[part + 'Id'] || 
                        event.payload[part.slice(0, -1) + 'Id'] || 
                        event.payload.id
                    );
                    
                    if (id !== undefined) {
                        if (Array.isArray(targetDraft[arrayName])) {
                            const found = targetDraft[arrayName].find((item: any) => String(item.id) === String(id));
                            if (found) {
                                targetDraft = found;
                            }
                        } else if (Array.isArray(targetDraft[arrayName + 's'])) {
                            // Sometimes collection is plural
                            const found = targetDraft[arrayName + 's'].find((item: any) => String(item.id) === String(id));
                            if (found) {
                                targetDraft = found;
                            }
                        }
                    }
                }
                
                eventName = aggregateName + '.' + actionName + '.event';
            }
        }

        const eventKey = Object.keys(allEvents).find(key =>
            (allEventOverrides[key] || aggregateName + '.' + key + '.event') === eventName ||
            (allEventOverrides[key] || aggregateName + '.' + key + '.event') === event.type // fallback
        );
        if (eventKey && allEvents[eventKey]) {
            allEvents[eventKey](targetDraft, event);
        }
    }) as S;
}
