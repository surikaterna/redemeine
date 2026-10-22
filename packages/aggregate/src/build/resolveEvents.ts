import type { NamingStrategy } from '@redemeine/kernel';
import type { AggregateMixinLike, AggregateSelectorsMap } from '../types/aggregate';

export type ResolvedEvents<TMeta> = {
    allEvents: Record<string, Function>;
    allEventMetadata: Record<string, TMeta | undefined>;
    allEventOverrides: Record<string, string>;
    /** O(1) lookup by resolved event type string */
    projectorByEventType: Map<string, Function>;
    explicitRootProjectorByEventType: Map<string, Function>;
    scopedProjectorByEventType: Record<string, Function>;
    scopedEventProjectors: Record<string, Function>;
    eventTypesByKey: Record<string, string>;
};

/**
 * Merges mixin events/projectors/overrides and builds lookup structures.
 */
export function resolveEvents<S, TMeta>(
    snapshot: {
        events: Record<string, Function>;
        eventMetadata: Record<string, Record<string, unknown> | undefined>;
        eventOverrides: Record<string, string>;
    },
    mixins: AggregateMixinLike<S>[],
    aggregateName: string,
    namingStrategy: NamingStrategy
): ResolvedEvents<TMeta> {
    const allEvents = mixins.reduce<Record<string, Function>>(
        (acc, m) => ({ ...acc, ...(m.projectors || m.events) }),
        { ...snapshot.events }
    );

    const allEventMetadata: Record<string, TMeta | undefined> = {
        ...(snapshot.eventMetadata as Record<string, TMeta | undefined>)
    };
    mixins.forEach((m) => {
        Object.assign(allEventMetadata, (m.eventMetadata || {}) as Record<string, TMeta | undefined>);
    });

    const allEventOverrides = mixins.reduce(
        (acc, m) => ({ ...acc, ...(m.eventOverrides || {}) }),
        snapshot.eventOverrides
    );

    const projectorByEventType = new Map<string, Function>();
    const scopedProjectorByEventType: Record<string, Function> = {};
    const scopedEventProjectors: Record<string, Function> = {};

    // Build eventTypesByKey for all root-level events
    const eventTypesByKey: Record<string, string> = {};
    Object.keys(allEvents).forEach((key) => {
        eventTypesByKey[key] = allEventOverrides[key] || namingStrategy.event(aggregateName, key);
    });

    return {
        allEvents,
        allEventMetadata,
        allEventOverrides,
        projectorByEventType,
        explicitRootProjectorByEventType: captureExplicitRootProjectors(allEvents, allEventOverrides),
        scopedProjectorByEventType,
        scopedEventProjectors,
        eventTypesByKey
    };
}

// Capture root ownership before entity mounting merges and replaces event keys.
function captureExplicitRootProjectors(
    events: Record<string, Function>,
    overrides: Record<string, string>
): Map<string, Function> {
    const projectors = new Map<string, Function>();
    Object.keys(events).forEach((key) => {
        const override = overrides[key];
        if (override) projectors.set(override, events[key]!);
    });
    return projectors;
}

/**
 * Finalizes projector map after entity mounting has populated scoped projectors.
 * Must be called after mountEntities.
 */
export function finalizeProjectorMap(
    allEvents: Record<string, Function>,
    allEventOverrides: Record<string, string>,
    projectorByEventType: Map<string, Function>,
    aggregateName: string,
    namingStrategy: NamingStrategy
): void {
    Object.keys(allEvents).forEach((eventKey) => {
        const resolvedEventType = allEventOverrides[eventKey] || namingStrategy.event(aggregateName, eventKey);
        if (!projectorByEventType.has(resolvedEventType)) {
            projectorByEventType.set(resolvedEventType, allEvents[eventKey]!);
        }
    });
}
