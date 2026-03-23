import { produce } from 'immer';
import { Event } from '../types';
import { parseTargetedEventPath, formatFlatEventType } from './naming';

export function applyEvent<S>(
    aggregateName: string,
    state: S,
    event: Event,
    allEvents: Record<string, Function>,
    allEventOverrides: Record<string, string>
): S {
    return produce(state, (draft: any) => {
        let targetDraft = draft;
        let eventName = event.type;
        
        const parsedPath = parseTargetedEventPath(event.type, aggregateName);
        if (parsedPath) {
            for (const part of parsedPath.parts) {
                const arrayName = part;
                const id = event.payload && (
                    event.payload[part + 'Id'] ||
                    event.payload[part.slice(0, -1) + 'Id'] || 
                    event.payload.id
                );

                if (id !== undefined) {
                    if (Array.isArray(targetDraft[arrayName])) {
                        const found = targetDraft[arrayName].find((item: any) => String(item.id) === String(id));
                        if (found) targetDraft = found;
                    } else if (Array.isArray(targetDraft[arrayName + 's'])) {
                        const found = targetDraft[arrayName + 's'].find((item: any) => String(item.id) === String(id));
                        if (found) targetDraft = found;
                    }
                }
            }
            eventName = parsedPath.coreEventName;
        }

        const eventKey = Object.keys(allEvents).find(key => {
            const fallbackType = formatFlatEventType(aggregateName, key);
            return (allEventOverrides[key] || fallbackType) === eventName ||
                   (allEventOverrides[key] || fallbackType) === event.type;
        });

        if (eventKey && allEvents[eventKey]) {
            allEvents[eventKey](targetDraft, event);
        }
    }) as S;
}
