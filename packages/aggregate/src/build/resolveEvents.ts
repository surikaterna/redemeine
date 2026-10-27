import type { NamingStrategy } from '@redemeine/kernel';
import type { AggregateMixinLike } from '../types/aggregate';
import type { CompiledEventRegistration } from '../applyEvent';
import { definitionTargets, snapshotTargetChain } from './entityCommandTarget';
import { eventDefinitionKeys, mergeEventDefinitions } from './eventDefinitions';

export type ResolvedEvents<TMeta> = {
    allEvents: Record<string, Function>;
    allEventMetadata: Record<string, TMeta | undefined>;
    allEventOverrides: Record<string, string>;
    dispatch: Map<string, CompiledEventRegistration>;
};

/** Capture declared ownership before mounting adds entity-only reflection keys. */
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
        (acc, m) => mergeEventDefinitions(acc, m.projectors || m.events || {}),
        mergeEventDefinitions({}, snapshot.events)
    );
    const allEventMetadata: Record<string, TMeta | undefined> = {
        ...(snapshot.eventMetadata as Record<string, TMeta | undefined>)
    };
    mixins.forEach((m) => {
        Object.assign(allEventMetadata, (m.eventMetadata || {}) as Record<string, TMeta | undefined>);
    });
    const allEventOverrides = mixins.reduce<Record<string, string>>(
        (acc, m) => ({ ...acc, ...(m.eventOverrides || {}) }),
        { ...snapshot.eventOverrides }
    );
    return {
        allEvents,
        allEventMetadata,
        allEventOverrides,
        dispatch: compileDeclaredEvents(allEvents, allEventOverrides, aggregateName, namingStrategy)
    };
}

function compileDeclaredEvents(
    events: Record<string, Function>,
    overrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy
): Map<string, CompiledEventRegistration> {
    const dispatch = new Map<string, CompiledEventRegistration>();
    const targets = definitionTargets(events);
    // Flattened components retain scoped ownership even without mounts to replay.
    // Scoped declarations win exact root collisions, regardless of root key order.
    for (const scoped of [false, true]) {
        for (const key of eventDefinitionKeys(events)) {
            const chain = targets[key] ?? [];
            if (Boolean(chain.length) !== scoped) continue;
            const type = overrides[key] || namingStrategy.event(aggregateName, key);
            dispatch.set(type, { projector: events[key]!, targets: snapshotTargetChain(chain) });
        }
    }
    return dispatch;
}
