import { produce } from 'immer';
import { Event } from '../types';
import { parseTargetedEventPath, formatFlatEventType } from './naming';

export function applyEvent<S>(
    aggregateName: string,
    state: S,
    event: Event,
    allEvents: Record<string, Function>,
    allEventOverrides: Record<string, string>,
    projectorByEventType: Record<string, Function> = {},
    scopedProjectorByEventType: Record<string, Function> = {},
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

                const mapKey = event.payload && (
                    event.payload[part + 'Key'] ||
                    event.payload[singularPart + 'Key'] ||
                    event.payload[camelArrayName + 'Key'] ||
                    event.payload[singularCamelPart + 'Key'] ||
                    event.payload.key
                );

                const compositePk = event.payload && event.payload.__entityPk && typeof event.payload.__entityPk === 'object'
                    ? event.payload.__entityPk
                    : undefined;

                const arrayCandidates = Array.from(new Set([
                    arrayName,
                    arrayName + 's',
                    camelArrayName,
                    camelArrayName + 's'
                ]));

                for (const candidate of arrayCandidates) {
                    const container = targetDraft[candidate];

                    if (Array.isArray(container)) {
                        const found = container.find((item: any) => {
                            if (id !== undefined) {
                                return String(item.id) === String(id);
                            }
                            if (compositePk) {
                                return Object.keys(compositePk).every((k) => String(item?.[k]) === String(compositePk[k]));
                            }
                            return false;
                        });

                        if (found) {
                            targetDraft = found;
                            break;
                        }
                    }

                    if (container && typeof container === 'object' && !Array.isArray(container) && mapKey !== undefined) {
                        const found = container[mapKey];
                        if (found) {
                            targetDraft = found;
                            break;
                        }
                    }
                }
            }
            eventName = parsedPath.coreEventName;
        }

        const directScopedProjector = scopedProjectorByEventType[event.type];
        if (directScopedProjector) {
            directScopedProjector(targetDraft, event);
            return;
        }

        const directProjector = projectorByEventType[eventName] || projectorByEventType[event.type];
        if (directProjector) {
            directProjector(targetDraft, event);
            return;
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
