import { Command, Event, AggregateHooks } from './types';
import { Depot } from './Depot';
import { Contract } from './Contract';

/**
 * Represents the instantiated, running state of the aggregate after the builder's .build() method is called.
 * It contains the initial state and the internal processing/application functions.
 */
export interface BuiltAggregate<S, M> {
    initialState: S;
    process: (state: S, command: Command<any, string>) => Event[];
    apply: (state: S, event: Event) => S;
    hooks?: AggregateHooks<S>;
    commandCreators: {
        [K in keyof M]: [M[K]] extends [void] | [undefined] | [never]
            ? () => Command<void, string>
            : (payload: M[K]) => Command<M[K], string>;
    };
}

/**
 * A mapped record of executable live commands bound directly to the aggregate instance.
 * These methods dispatch commands and return a promise resolving to the mutated state.
 */
export type LiveCommandMap<S, M> = {
    [K in keyof M]: [M[K]] extends [void] | [undefined] | [never]
        ? () => Promise<S>
        : (payload: M[K]) => Promise<S>;
};

/**
 * A private symbol used to access internal dispatch mechanisms (LiveAggregateCore) 
 * without polluting the public aggregate API methods.
 */
export const LiveAggregateCoreSymbol = Symbol('LiveAggregateCore');

/**
 * Configuration options strictly passed during the instantiation of a live aggregate.
 */
export interface LiveAggregateOptions {
    contract?: Contract;
    strict?: boolean;
}

/**
 * The internal core controller of a Live Aggregate instance.
 * Tracks the uncommitted events, current version, and executes the core command routing.
 */
export class LiveAggregateCore<S> {
    public uncommitted: Event[] = [];
    public version: number = 0;

    constructor(
        public builder: BuiltAggregate<S, any>,
        public id: string,
        public state: S,
        public contract?: Contract,
        public strict: boolean = false
    ) {}
}

export function createLiveAggregate<S extends {}, Name extends string, M extends Record<string, any>>(
    builder: BuiltAggregate<S, M>,
    id: string,
    initialState?: S,
    options?: LiveAggregateOptions
): LiveCommandMap<S, M> & Readonly<S> & Record<string, any> {

    const core = new LiveAggregateCore(builder, id, initialState || builder.initialState, options?.contract, options?.strict);

const makeDeepProxy = (stateTarget: any, path: string[], ids: Record<string, string | number>): any => {
        return new Proxy(typeof stateTarget === 'object' && stateTarget !== null ? stateTarget : () => {}, {
            get(target, prop) {
                if (path.length === 0 && prop === LiveAggregateCoreSymbol) {
                    return core;
                }

                if (typeof prop !== 'string') {
                    return Reflect.get(target, prop);
                }

                if (prop === 'then') return undefined;

                if (["asymmetricMatch", "nodeType", "@@toStringTag", "toJSON", "toString", "valueOf", "inspect"].includes(prop)) {
                    return Reflect.get(target, prop);
                }

                // At root level, always use current core.state to prevent staleness
                const currentTarget = path.length === 0 ? core.state : target;

                // If the property exists in the state object, we proxy it to allow BOTH reading and path-building.
                if (currentTarget && typeof currentTarget === 'object' && prop in currentTarget) {
                    const val = (currentTarget as any)[prop];
                    if (typeof val === 'function' && Array.isArray(currentTarget)) {
                        return val.bind(currentTarget);
                    }
                    if (typeof val === 'object' && val !== null) {
                        return makeDeepProxy(val, [...path, prop], { ...ids });
                    }
                    return val;
                }

                const nextIds = { ...ids };
                const nextPath = [...path];

                if (path.length > 0 && typeof prop === 'string' && !isNaN(Number(prop))) {
                    const parent = path[path.length - 1];
                    nextIds[parent + 'Id'] = prop;
                    nextIds['id'] = prop;
                } else if (path.length > 0 && typeof prop === 'string') {
                    // For string-based IDs like 'abc'
                    if (prop !== 'update' && prop !== 'add' && prop !== 'remove' && prop !== 'delete') {
                         const parent = path[path.length - 1];
                         nextIds[parent + 'Id'] = prop;
                         nextIds['id'] = prop;
                    } else {
                         nextPath.push(prop);
                    }
                } else {
                    nextPath.push(prop);
                }

                return makeDeepProxy(() => {}, nextPath, nextIds);
            },

            async apply(target, thisArg, args) {
                const funcName = path.reduce(
                    (acc, p, i) => acc + (i === 0 ? p : p.charAt(0).toUpperCase()) + p.slice(1),
                    ''
                );

                let payload = args[0];

                if (typeof payload === 'object' && payload !== null) {
                    payload = { ...payload, ...ids };
                } else if (payload !== undefined) {
                    if (Object.keys(ids).length > 0) {
                        payload = { value: payload, ...ids };
                    }
                } else if (Object.keys(ids).length > 0) {
                    payload = { ...ids };
                }

                const cmd = (builder.commandCreators as any)[funcName](payload);
                if (!cmd) {
                    throw new Error('Command ' + funcName + ' not found on commandCreators.');
                }

                if (core.builder.hooks?.onBeforeCommand) {
                    await core.builder.hooks.onBeforeCommand(cmd, core.state as any);
                }

                if (core.contract) {
                    try {
                        core.contract.validateCommand(cmd.type, cmd.payload);
                    } catch (err: any) {
                        if (err.message.includes('schema not found')) {
                            if (core.strict) throw err;
                            console.warn(err.message);
                        } else {
                            throw err;
                        }
                    }
                }

                const events = builder.process(core.state, cmd);
                
                if (core.builder.hooks?.onAfterCommand) {
                    await core.builder.hooks.onAfterCommand(cmd, events, core.state as any);
                }

                for (const ev of events) {
                    if (core.contract) {
                        try {
                            core.contract.validateEvent(ev.type, ev.payload);
                        } catch (err: any) {
                            if (err.message.includes('schema not found')) {
                                if (core.strict) throw err;
                                console.warn(err.message);
                            } else {
                                throw err;
                            }
                        }
                    }
                    core.state = builder.apply(core.state, ev);
                    core.uncommitted.push(ev);
                    if (core.builder.hooks?.onEventApplied) {
                        core.builder.hooks.onEventApplied(ev, core.state as any);
                    }
                }
                return Promise.resolve(core.state);
            }
        });
    };

    return makeDeepProxy(core.state, [], {}) as LiveCommandMap<S, M> & Readonly<S> & Record<string, any>;
}

export function createLegacyAggregateBridge<S, M>(liveAggregate: LiveCommandMap<S, M> & Readonly<S> & Record<string, any>) {
    const core = (liveAggregate as any)[LiveAggregateCoreSymbol] as LiveAggregateCore<S>;
    if (!core) {
        throw new Error('Target is not a valid LiveAggregate.');
    }
    return {
        get id() { return core.id; },
        get _state() { return core.state; },
        getVersion: () => core.version,
        clearUncommittedEvents: () => { core.uncommitted = []; },
        getUncommittedEvents: () => [...core.uncommitted],
        getUncommittedEventsAsync: async () => [...core.uncommitted],
    };
}

/**
 * Represents a storage mechanism binding the instantiated aggregate state lifecycle
 * directly to your underlying database representations (Depot).
 * Facilitates hydration (`findById`) and persistence (`save`).
 */
export class LiveAggregateDepot<S, M extends Record<string, any>> {
    constructor(
        private builder: BuiltAggregate<S, M>,
        private depot: Depot<string, S>,
        private options?: LiveAggregateOptions
    ) {}

    async findById(id: string): Promise<LiveCommandMap<S, M> & Readonly<S> & Record<string, any>> {
        const state = await this.depot.findOne(id);
        if (state && this.options?.contract) {
            this.options.contract.validateState(state);
        }
        return createLiveAggregate(this.builder, id, state || this.builder.initialState, this.options);
    }

    new(id: string = Math.random().toString(36).substring(2)): LiveCommandMap<S, M> & Readonly<S> & Record<string, any> {
        return createLiveAggregate(this.builder, id, this.builder.initialState, this.options);
    }

    async save(liveAggregate: LiveCommandMap<S, M> & Readonly<S> & Record<string, any>): Promise<S> {
        const core = (liveAggregate as any)[LiveAggregateCoreSymbol] as LiveAggregateCore<S>;
        if (!core) throw new Error('Not a valid LiveAggregate');
        
        await this.depot.save(core.state);
        core.uncommitted = [];
        return core.state;
    }
}
