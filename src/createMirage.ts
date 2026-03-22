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
    depot?: any;
}

/**
 * A mapped record of executable live commands bound directly to the aggregate instance.
 * These methods dispatch commands and return a promise resolving to the mutated state.
 */
export type MirageCommandMap<S, M> = {
    [K in keyof M]: [M[K]] extends [void] | [undefined] | [never]
        ? () => Promise<S>
        : (payload: M[K]) => Promise<S>;
};

export type Mirage<TState, M extends Record<string, any> = any> = 
    MirageCommandMap<TState, M> & Readonly<TState> & {
        readonly state: Readonly<TState>;
        dispatch: (command: any) => Promise<TState>;
        subscribe: (listener: (state: TState) => void) => () => void;
    } & Record<string, any>;

/**
 * A private symbol used to access internal dispatch mechanisms (MirageCore) 
 * without polluting the public aggregate API methods.
 */
export const MirageCoreSymbol = Symbol('MirageCore');

/**
 * Configuration options strictly passed during the instantiation of a Mirage instance.
 */
export interface MirageOptions {
    contract?: Contract;
    strict?: boolean;
}

/**
 * The internal core controller of a Mirage instance.
 * Tracks the uncommitted events, current version, and executes the core command routing.
 */
export class MirageCore<S> {
    public uncommitted: Event[] = [];
    public version: number = 0;
    private listeners: ((state: S) => void)[] = [];

    constructor(
        public builder: BuiltAggregate<S, any>,
        public id: string,
        public state: S,
        public contract?: Contract,
        public strict: boolean = false
    ) {}

    public subscribe(listener: (state: S) => void) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    public notify() {
        this.listeners.forEach(l => l(this.state));
    }

    public async dispatch(cmd: any): Promise<S> {
        if (this.builder.hooks?.onBeforeCommand) {
            await this.builder.hooks.onBeforeCommand(cmd, this.state as any);
        }

        if (this.contract) {
            try {
                this.contract.validateCommand(cmd.type, cmd.payload);
            } catch (err: any) {
                if (err.message.includes('schema not found')) {
                    if (this.strict) throw err;
                    console.warn(err.message);
                } else {
                    throw err;
                }
            }
        }

        const events = this.builder.process(this.state, cmd);
        
        if (this.builder.hooks?.onAfterCommand) {
            await this.builder.hooks.onAfterCommand(cmd, events, this.state as any);
        }

        for (const ev of events) {
            if (this.contract) {
                try {
                    this.contract.validateEvent(ev.type, ev.payload);
                } catch (err: any) {
                    if (err.message.includes('schema not found')) {
                        if (this.strict) throw err;
                        console.warn(err.message);
                    } else {
                        throw err;
                    }
                }
            }
            this.state = this.builder.apply(this.state, ev);
            this.uncommitted.push(ev);
            if (this.builder.hooks?.onEventApplied) {
                this.builder.hooks.onEventApplied(ev, this.state as any);
            }
        }
        this.version++;
        this.notify();
        return this.state;
    }
}

export function createMirage<S extends {}, Name extends string, M extends Record<string, any>>(
    builder: BuiltAggregate<S, M>,
    id: string,
    initialState?: S,
    options?: MirageOptions
): Mirage<S, M> {

    const core = new MirageCore(builder, id, initialState || builder.initialState, options?.contract, options?.strict);

const makeDeepProxy = (stateTarget: any, path: string[], ids: Record<string, string | number>): any => {
        return new Proxy(typeof stateTarget === 'object' && stateTarget !== null ? stateTarget : () => {}, {
            get(target, prop) {
                if (path.length === 0) {
                    if (prop === 'state') return core.state;
                    if (prop === 'dispatch') return core.dispatch.bind(core);
                    if (prop === 'subscribe') return core.subscribe.bind(core);
                    if (prop === MirageCoreSymbol) return core;
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
                    (acc, p, i) => acc + (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)),
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

                return core.dispatch(cmd);

            }
        });
    };

    return makeDeepProxy(core.state, [], {}) as Mirage<S, M>;
}

export function createLegacyAggregateBridge<S, M>(mirage: Mirage<S, M>) {
    const core = (mirage as any)[MirageCoreSymbol] as MirageCore<S>;
    if (!core) {
        throw new Error('Target is not a valid Mirage Instance.');
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
