import { Command, Event, AggregateHooks } from './types';
import { Contract } from './Contract';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';

/**
 * Represents the instantiated, running state of the aggregate after the builder's .build() method is called.
 * It contains the initial state and the internal processing/application functions.
 */
export interface BuiltAggregate<S, M, E = any> {
    initialState: S;
    process: (state: S, command: Command<any, string>) => Event[];
    apply: (state: S, event: Event) => S;
    hooks?: AggregateHooks<S>;
    commandCreators: {
        [K in keyof M]: M[K] extends { args: infer Args, payload: infer P }
            ? (...args: Args extends any[] ? Args : never) => Command<P, string>
            : [M[K]] extends [void] | [undefined] | [never]
                ? () => Command<void, string>
                : (payload: M[K]) => Command<M[K], string>;
    };
    eventCreators: E;
    /** The raw, un-routed domain functions. STRICTLY FOR ISOLATED UNIT TESTING. Do not use these to bypass the Mirage dispatch loop in production as it will skip lifecycle hooks. */
    pure: {
        commandProcessors: Record<string, Function>;
        eventProjectors: Record<string, Function>;
    };
}

/**
 * A mapped record of executable live commands bound directly to the aggregate instance.
 * These methods dispatch commands and return a promise resolving to the mutated state.
 */
export type MirageCommandMap<S, M> = {
    [K in keyof M]: M[K] extends { args: infer Args, payload: infer P }
        ? (...args: Args extends any[] ? Args : never) => Promise<S>
        : [M[K]] extends [void] | [undefined] | [never]
            ? () => Promise<S>
            : (payload: M[K]) => Promise<S>;
};

/**
 * The standard active instantiated aggregate wrapper holding bounded paths.
 * 
 * Features Immutable Hybrid Entity Collections:
 * Nested entities mapped by `.entities()` return a wrapper which is both a Read-Only Array
 * and a Path function constructor.
 * 
 * Example: `mirage.orderLines('123')` retrieves the targeted Entity Mirage.
 * Example: `mirage.orderLines.length` behaves as a safe read-only array reference.
 */
export type Mirage<TState, M extends Record<string, any> = any> = 
    MirageCommandMap<TState, M> & ReadonlyDeep<TState> & {
        readonly state: ReadonlyDeep<TState>;
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
    setup?: MirageOptions & { snapshot?: S; events?: Event[] }
): Mirage<S, M> {

    const state = setup?.events?.reduce((acc, ev) => builder.apply(acc, ev), setup?.snapshot ?? builder.initialState) ?? (setup?.snapshot ?? builder.initialState);
    const core = new MirageCore(builder, id, state, setup?.contract, setup?.strict);

    const resolvePath = (path: string[]) => {
        let current: any = core.state;
        for (const p of path) {
            if (current && typeof current === 'object') {
                current = current[p];
            } else {
                return undefined;
            }
        }
        return current;
    };

    const makeReadonlyProxy = (obj: any): any => {
        if (typeof obj !== 'object' || obj === null) return obj;
        return new Proxy(obj, {
            get(target, prop) {
                return makeReadonlyProxy(Reflect.get(target, prop));
            },
            set() {
                throw new Error('Cannot mutate properties directly');
            },
            deleteProperty() {
                throw new Error('Cannot mutate properties directly');
            }
        });
    };

    const makeEntityMirageProxy = (collectionPath: string[], entityId: string, ids: Record<string, string | number>): any => {
        return new Proxy({}, {
            get(target, prop) {
                if (typeof prop !== 'string') return Reflect.get(target, prop);
                if (prop === 'then') return undefined;

                const collection = resolvePath(collectionPath);
                const entity = collection?.find((e: any) => e.id === entityId || e.id === Number(entityId));

                // Merge state properties
                if (entity && prop in entity) {
                    return makeReadonlyProxy(entity[prop]);
                }

                // If not in state, assume it's a command creator builder
                return makeDeepProxy([...collectionPath, prop], ids);
            },
            set() {
                throw new Error('Cannot mutate properties directly');
            }
        });
    };

    const makeCollectionProxy = (collectionPath: string[], ids: Record<string, string | number>): any => {
        const fn = function(id: string) {
            const nextIds = { ...ids };
            const parent = collectionPath[collectionPath.length - 1];
            nextIds[parent + 'Id'] = id;
            nextIds['id'] = id;
            return makeEntityMirageProxy(collectionPath, id, nextIds);
        };

        return new Proxy(fn, {
            get(target, prop) {
                if (prop === 'then') return undefined;
                
                const collection = resolvePath(collectionPath) || [];

                if (typeof prop !== 'string') {
                    if (prop === Symbol.iterator) return collection[Symbol.iterator].bind(collection);
                    return Reflect.get(target, prop);
                }

                if (['set', 'push', 'pop', 'splice'].includes(prop)) {
                    return () => { throw new Error('Cannot mutate collection directly'); };
                }

                if (prop === 'length') return collection.length;

                if (!isNaN(Number(prop))) return makeReadonlyProxy(collection[Number(prop)]);

                if (typeof (collection as any)[prop] === 'function') {
                    return (collection as any)[prop].bind(collection);
                }

                return Reflect.get(target, prop);
            },
            set() {
                throw new Error('Cannot mutate collection directly');
            }
        });
    };

    const makeDeepProxy = (path: string[], ids: Record<string, string | number>): any => {
        return new Proxy(function() {}, {
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

                const currentTarget = resolvePath(path);

                if (currentTarget && typeof currentTarget === 'object' && prop in currentTarget) {
                    const val = (currentTarget as any)[prop];
                    
                    if (Array.isArray(val)) {
                        return makeCollectionProxy([...path, prop], ids);
                    }
                    
                    if (typeof val === 'function' && Array.isArray(currentTarget)) {
                        return val.bind(currentTarget);
                    }
                    if (typeof val === 'object' && val !== null) {
                        return makeDeepProxy([...path, prop], { ...ids });
                    }
                    return val;
                }

                const nextIds = { ...ids };
                const nextPath = [...path, prop];

                if (typeof prop === 'string' && !isNaN(Number(prop))) {
                    if (path.length > 0) {
                        const parent = path[path.length - 1];
                        nextIds[parent + 'Id'] = prop;
                    }
                    nextIds['id'] = prop;
                } else if (typeof prop === 'string') {
                    // Handled by nextPath array above
                }

                return makeDeepProxy(nextPath, nextIds);
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

    return makeDeepProxy([], {}) as Mirage<S, M>;
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
