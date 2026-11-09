import type { NamingStrategy } from '@redemeine/kernel';
import type { AggregateMixinLike } from '../types/aggregate';
import type { CompiledEventRegistration } from '../applyEvent';
import { definitionTargets, snapshotTargetChain } from './entityCommandTarget';
import { eventDefinitionKeys, mergeEventDefinitions, eventOrigin } from './eventDefinitions';
import { ownDefinition } from './definitionMap';
import { mountedWire } from './mountedNaming';

export type ResolvedEvents<TMeta> = {
    allEvents: Record<string, Function>;
    allEventMetadata: Record<string, TMeta | undefined>;
    allEventOverrides: Record<string, string>;
    dispatch: Map<string, CompiledEventRegistration<TMeta>>;
    forward: { wireType: string; registration: CompiledEventRegistration<TMeta> }[];
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
        mergeEventDefinitions(Object.create(null), snapshot.events)
    );
    const allEventMetadata: Record<string, TMeta | undefined> = Object.assign(Object.create(null), snapshot.eventMetadata);
    mixins.forEach((m) => {
        Object.assign(allEventMetadata, (m.eventMetadata || {}) as Record<string, TMeta | undefined>);
    });
    const allEventOverrides = mixins.reduce<Record<string, string>>(
        (acc, m) => ({ ...acc, ...(m.eventOverrides || {}) }),
        { ...snapshot.eventOverrides }
    );
    const unsupported = new Set(mixins.flatMap(m => Object.keys(m.projectors || m.events || {})));
    const dispatch = compileDeclaredEvents(allEvents, allEventMetadata, allEventOverrides, aggregateName, namingStrategy, unsupported);
    const forward = declaredForward<TMeta>(allEvents, allEventOverrides, unsupported);
    return { allEvents, allEventMetadata, allEventOverrides, dispatch, forward };
}

function declaredForward<TMeta>(allEvents: Record<string, Function>, overrides: Record<string, string>, unsupported: Set<string>): ResolvedEvents<TMeta>['forward'] {
    const forward: ResolvedEvents<TMeta>['forward'] = [];
    for (const key of eventDefinitionKeys(allEvents)) {
        const origin = eventOrigin(allEvents, key);
        forward.push({ wireType: overrides[key]!, registration: {
            projector: allEvents[key]!, targets: [], schemaOrigin: origin,
            unsupportedSchema: unsupported.has(key) && origin.segments.length === 1
        } });
    }
    return forward;
}

function compileDeclaredEvents<TMeta>(
    events: Record<string, Function>,
    metadata: Record<string, TMeta | undefined>,
    overrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy,
    unsupported: Set<string>
): Map<string, CompiledEventRegistration<TMeta>> {
    const dispatch = new Map<string, CompiledEventRegistration<TMeta>>();
    const targets = definitionTargets(events);
    // Flattened components retain scoped ownership even without mounts to replay.
    // Scoped declarations win exact root collisions, regardless of root key order.
    for (const scoped of [false, true]) {
        for (const key of eventDefinitionKeys(events)) {
            const chain = targets[key] ?? [];
            if (Boolean(chain.length) !== scoped) continue;
            const type = ownDefinition(overrides, key) || mountedWire(events, key, aggregateName, namingStrategy, 'event')
                || namingStrategy.event(aggregateName, key);
            overrides[key] = type;
            const origin = eventOrigin(events, key);
            dispatch.set(type, { projector: events[key]!, targets: snapshotTargetChain(chain), metadata: ownDefinition(metadata, key),
                schemaOrigin: origin, unsupportedSchema: unsupported.has(key) && origin.segments.length === 1 });
        }
    }
    return dispatch;
}
