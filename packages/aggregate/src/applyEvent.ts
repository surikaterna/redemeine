import { produce, type Draft } from 'immer';
import type { Event } from '@redemeine/kernel';
import { toCamelCase, singular, parseTargetedEventPath, formatFlatEventType } from './naming';

/**
 * Resolves an event path segment to the matching entity container in the draft.
 * Tries multiple naming conventions (snake_case, camelCase, with/without plural 's')
 * because the event type path may use a different convention than the state property.
 * 
 * TODO: Pass entity mount metadata from the aggregate builder to eliminate guesswork.
 */
function resolveEntityContainer(
    part: string,
    draft: Record<string, any>
): { container: any; kind: 'array' | 'map' } | undefined {
    const camelPart = toCamelCase(part);
    const candidates = Array.from(new Set([
        part,
        part + 's',
        camelPart,
        camelPart + 's'
    ]));

    for (const candidate of candidates) {
        const value = draft[candidate];
        if (Array.isArray(value)) return { container: value, kind: 'array' };
        if (value && typeof value === 'object' && !Array.isArray(value)) return { container: value, kind: 'map' };
    }

    return undefined;
}

/**
 * Resolves the entity identifier from the event payload for a given path segment.
 * Tries multiple naming conventions for the ID/key fields.
 *
 * TODO: Pass entity mount metadata to use the known primary key field directly.
 */
function resolveEntityIdentifier(
    part: string,
    payload: Record<string, any>
): { id?: unknown; mapKey?: unknown; compositePk?: Record<string, unknown> } {
    const camelPart = toCamelCase(part);
    const singularPart = singular(part);
    const singularCamelPart = singular(camelPart);

    const id = payload[part + 'Id'] ||
        payload[singularPart + 'Id'] ||
        payload[camelPart + 'Id'] ||
        payload[singularCamelPart + 'Id'] ||
        payload.id;

    const mapKey = payload[part + 'Key'] ||
        payload[singularPart + 'Key'] ||
        payload[camelPart + 'Key'] ||
        payload[singularCamelPart + 'Key'] ||
        payload.key;

    const compositePk = payload.__entityPk && typeof payload.__entityPk === 'object'
        ? payload.__entityPk as Record<string, unknown>
        : undefined;

    return { id, mapKey, compositePk };
}

/**
 * Applies an event to a mutable draft state by routing to the correct projector.
 * Does NOT wrap in Immer — the caller is responsible for immutability.
 * Used by projections that already operate within their own Immer context.
 */
export function applyEventToDraft<S>(
    aggregateName: string,
    draft: Draft<S>,
    event: Event,
    allEvents: Record<string, Function>,
    allEventOverrides: Record<string, string>,
    projectorByEventType: Record<string, Function> = {},
    scopedProjectorByEventType: Record<string, Function> = {},
    scopedEventProjectors: Record<string, Function> = {}
): void {
    let targetDraft = draft;
    let eventName = event.type;
    
    const parsedPath = parseTargetedEventPath(event.type, aggregateName);
    if (parsedPath) {
        for (const part of parsedPath.parts) {
            const resolved = resolveEntityContainer(part, targetDraft);
            if (!resolved) continue;

            const { id, mapKey, compositePk } = event.payload
                ? resolveEntityIdentifier(part, event.payload)
                : { id: undefined, mapKey: undefined, compositePk: undefined };

            if (resolved.kind === 'array') {
                const found = (resolved.container as any[]).find((item: any) => {
                    if (id !== undefined) return String(item.id) === String(id);
                    if (compositePk) return Object.keys(compositePk).every(k => String(item?.[k]) === String(compositePk[k]));
                    return false;
                });
                if (found) targetDraft = found;
            } else if (resolved.kind === 'map' && mapKey !== undefined) {
                const found = resolved.container[mapKey as string];
                if (found) targetDraft = found;
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
}

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
        applyEventToDraft(aggregateName, draft, event, allEvents, allEventOverrides, projectorByEventType, scopedProjectorByEventType, scopedEventProjectors);
    }) as S;
}
