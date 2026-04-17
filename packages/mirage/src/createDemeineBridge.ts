import type { Event, Command } from '@redemeine/kernel';
import { createIdentity } from '@redemeine/kernel';

/**
 * Minimal interface describing what the bridge needs from a built aggregate.
 */
export interface BridgeableAggregate<S extends object> {
    initialState: S;
    process: (state: S, command: Command) => Event[];
    apply: (state: S, event: Event) => S;
    types: {
        commands: Record<string, string>;
        events: Record<string, string>;
    };
}

export interface DemeineCompatibleAggregate<S extends object = object> {
    id: string;
    type: string;
    _state: S;
    _version: number;
    _uncommittedEvents: Event[];

    _rehydrate(events: Event[], version?: number, snapshot?: S): Promise<void>;
    _apply(event: Event & { aggregateId?: string }, isNew?: boolean): DemeineCompatibleAggregate<S>;
    _getSnapshot(): S | undefined;

    _sink(command: Command & { aggregateId?: string }): Promise<DemeineCompatibleAggregate<S>>;
    _process(command: Command): Promise<DemeineCompatibleAggregate<S>>;

    getVersion(): number;
    getUncommittedEvents(): Event[];
    getUncommittedEventsAsync(): Promise<Event[]>;
    clearUncommittedEvents(): Event[];

    delete(): Promise<DemeineCompatibleAggregate<S>>;
    processDelete(command: Command): DemeineCompatibleAggregate<S>;
    applyDeleted(): void;

    [key: string]: any;
}

// Replicate demeine's string utilities
const camelCase = (str: string): string =>
    str.replace(/_([a-z])/g, (g) => g[1].toUpperCase());

const capitalize = (str: string): string =>
    `${str.charAt(0).toUpperCase()}${str.slice(1)}`;

/**
 * Derives the processXxx method name from a command type string,
 * replicating demeine's DefaultCommandHandler._extractKey algorithm.
 */
function extractCommandKey(type: string): string {
    const parts = type.split('.');
    const filteredParts: string[] = [];
    for (let i = 1; i < parts.length - 1; i++) {
        filteredParts.push(parts[i]);
    }
    filteredParts.unshift(filteredParts.pop()!);
    return camelCase(filteredParts.join('_'));
}

/**
 * Derives the applyXxx method name from an event type string,
 * replicating demeine's DefaultEventHandler._extractKey algorithm.
 */
function extractEventKey(type: string): string {
    const parts = type.split('.');
    const filteredParts: string[] = [];
    for (let i = 1; i < parts.length - 1; i++) {
        filteredParts.push(parts[i]);
    }
    return camelCase(filteredParts.join('_'));
}

function deriveAggregateType(builder: BridgeableAggregate<any>): string {
    const allTypes = {
        ...builder.types.commands,
        ...builder.types.events
    };
    const firstType = Object.values(allTypes)[0];
    if (!firstType) return 'unknown';
    return firstType.split('.')[0];
}

export function createDemeineBridge<S extends object>(
    builder: BridgeableAggregate<S>
): (id: string) => DemeineCompatibleAggregate<S> {
    const aggregateType = deriveAggregateType(builder);

    // Pre-compute command method name → command type mapping
    const commandMethodMap = new Map<string, string>();
    for (const [, typeStr] of Object.entries(builder.types.commands)) {
        const methodName = `process${capitalize(extractCommandKey(typeStr))}`;
        commandMethodMap.set(methodName, typeStr);
    }

    // Pre-compute event method name → event type mapping
    const eventMethodMap = new Map<string, string>();
    for (const [, typeStr] of Object.entries(builder.types.events)) {
        const methodName = `apply${capitalize(extractEventKey(typeStr))}`;
        eventMethodMap.set(methodName, typeStr);
    }

    return function factory(id: string): DemeineCompatibleAggregate<S> {
        let state: S = structuredClone(builder.initialState);
        let version = 0;
        let uncommittedEvents: Event[] = [];

        const agg: DemeineCompatibleAggregate<S> = {
            id,
            type: aggregateType,

            get _state() { return state; },
            set _state(v: S) { state = v; },

            get _version() { return version; },
            set _version(v: number) { version = v; },

            get _uncommittedEvents() { return uncommittedEvents; },

            async _rehydrate(events: Event[], ver?: number, snapshot?: S): Promise<void> {
                if (snapshot) {
                    state = structuredClone(snapshot);
                }
                for (let i = 0; i < events.length; i++) {
                    agg._apply(events[i], false);
                    // Yield every 100 events to match demeine behavior
                    if (i % 100 === 0) {
                        await new Promise<void>(r => setTimeout(r, 0));
                    }
                }
                version = ver || version;
            },

            _apply(event: Event & { aggregateId?: string }, isNew = false) {
                if (!event.id) {
                    event.id = createIdentity();
                }
                if (!event.aggregateId) {
                    (event as any).aggregateId = id;
                }
                if (event.type !== '$stream.deleted.event') {
                    state = builder.apply(state, event);
                }
                if (version === -1) { version = 0; }
                version++;
                if (isNew) {
                    uncommittedEvents.push(event);
                }
                return agg;
            },

            _getSnapshot(): S | undefined {
                return state;
            },

            async _sink(command: Command & { aggregateId?: string }) {
                if (command.aggregateId && command.aggregateId !== id) {
                    throw new Error(
                        `Command aggregateId "${command.aggregateId}" does not match aggregate id "${id}"`
                    );
                }
                if (!command.id) {
                    command.id = createIdentity();
                }
                if (!command.aggregateId) {
                    (command as any).aggregateId = id;
                }
                if (aggregateType) {
                    (command as any).aggregateType = aggregateType;
                }
                return agg._process(command);
            },

            async _process(command: Command) {
                const events = builder.process(state, command);
                for (const event of events) {
                    agg._apply(event, true);
                }
                return agg;
            },

            getVersion() { return version; },
            getUncommittedEvents() { return uncommittedEvents; },
            async getUncommittedEventsAsync() { return uncommittedEvents; },
            clearUncommittedEvents() {
                const previous = uncommittedEvents;
                uncommittedEvents = [];
                return previous;
            },

            async delete() {
                return agg._sink({
                    type: '$stream.delete.command',
                    aggregateId: id,
                    payload: {}
                } as any);
            },

            processDelete(command: Command) {
                return agg._apply({
                    type: '$stream.deleted.event',
                    aggregateId: id,
                    correlationId: command.id,
                    payload: { aggregateType }
                } as any, true);
            },

            applyDeleted() { /* no-op */ }
        };

        // Generate processXxx methods from command types
        for (const [methodName, commandType] of commandMethodMap) {
            agg[methodName] = function (command: Command) {
                const events = builder.process(state, command);
                for (const event of events) {
                    agg._apply(event, true);
                }
                return agg;
            };
        }

        // Generate applyXxx methods from event types
        for (const [methodName, eventType] of eventMethodMap) {
            agg[methodName] = function (event: Event) {
                state = builder.apply(state, event);
                return undefined;
            };
        }

        return agg;
    };
}
