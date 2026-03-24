import { produce } from 'immer';
import { Event } from '../types';
import { parseTargetedEventPath, formatFlatEventType } from './naming';

export function applyEvent<S>(
    aggregateName: string,
    state: S,
    event: Event,
    allEvents: Record<string, Function>,
    allEventOverrides: Record<string, string>,
    scopedEventProjectors: Record<string, Function> = {}
): S {
    return produce(state, (draft: any) => {
        const toCamelCase = (value: string) => value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        const singular = (value: string) => value.endsWith('s') ? value.slice(0, -1) : value;

        let targetDraft = draft;
        let eventName = event.type;
        
        const parsedPath = parseTargetedEventPath(event.type, aggregateName);
        if (parsedPath) {
            for (const part of parsedPath.parts) {
                const arrayName = part;
                const camelArrayName = toCamelCase(part);
                const singularPart = singular(part);
                const singularCamelPart = singular(camelArrayName);
                const id = event.payload && (
                    event.payload[part + 'Id'] ||
                    event.payload[singularPart + 'Id'] ||
                    event.payload[camelArrayName + 'Id'] ||
                    event.payload[singularCamelPart + 'Id'] ||
                    event.payload.id
                );

                if (id !== undefined) {
                    const arrayCandidates = Array.from(new Set([
                        arrayName,
                        arrayName + 's',
                        camelArrayName,
                        camelArrayName + 's'
                    ]));

                    for (const candidate of arrayCandidates) {
                        if (Array.isArray(targetDraft[candidate])) {
                            const found = targetDraft[candidate].find((item: any) => String(item.id) === String(id));
                            if (found) {
                                targetDraft = found;
                                break;
                            }
                        }
                    }
                }
            }
            eventName = parsedPath.coreEventName;
        }

        const scopedPath = parsedPath ? parsedPath.parts.join('.') : undefined;
        const eventKey = Object.keys(allEvents).find(key => {
            const fallbackType = formatFlatEventType(aggregateName, key);
            const scopedOverride = scopedPath ? allEventOverrides[`${scopedPath}:${key}`] : undefined;
            const unscopedOverride = allEventOverrides[key];
            const resolvedType = scopedOverride || unscopedOverride || fallbackType;
            return resolvedType === eventName || resolvedType === event.type;
        });

        if (eventKey) {
            const scopedProjector = scopedPath ? scopedEventProjectors[`${scopedPath}:${eventKey}`] : undefined;
            const projector = scopedProjector || allEvents[eventKey];
            if (projector) {
                projector(targetDraft, event);
            }
        }
    }) as S;
}
