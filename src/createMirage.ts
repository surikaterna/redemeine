import { Command, Event, AggregateHooks } from './types';
import { Contract } from './Contract';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import type { PublicCommandMethodsFromInternal } from './redemeineComponent';
import type { EntityPackage } from './createEntity';
import type { AggregateEntityRegistry } from './createAggregate';

type MountKind = 'list' | 'map' | 'valueObject';

type MountMetadata = {
    kind: MountKind;
    commandPrefix: string;
    statePath: string[];
    pk?: string | readonly string[];
    knownKeys?: readonly string[];
};

type InvocationContext = {
    idsPayload: Record<string, unknown>;
    packPrefix: unknown[];
    entityPk?: Record<string, unknown>;
};

/**
 * Represents the instantiated, running state of the aggregate after the builder's .build() method is called.
 * It contains the initial state and the internal processing/application functions.
 */
export interface BuiltAggregate<S, M, E = any, Registry extends AggregateEntityRegistry = {}> {
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
    mounts?: Record<string, MountMetadata>;
    __registryType?: Registry;
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
} | (M extends Record<string, any> ? PublicCommandMethodsFromInternal<S, M, Promise<S>> : never);

type EntityStateOf<T> = T extends EntityPackage<infer ES, any, any, any, any, any, any> ? ES : never;
type EntityCommandsOf<T> = T extends EntityPackage<any, any, any, any, infer C, any, any> ? C : never;

type DropFirstN<Args extends any[], N extends number, Count extends any[] = []> =
    Count['length'] extends N
        ? Args
        : Args extends [any, ...infer Rest]
            ? DropFirstN<Rest, N, [...Count, any]>
            : [];

type InjectedArgCount<PK> = PK extends readonly any[] ? PK['length'] : 1;

type ScopedMirageCommandMap<TEntityState, TCommands, InjectedCount extends number> = {
    [K in keyof TCommands]: TCommands[K] extends { args: infer Args }
        ? (...args: DropFirstN<Args extends any[] ? Args : [], InjectedCount>) => Promise<TEntityState>
        : [TCommands[K]] extends [void] | [undefined] | [never]
            ? () => Promise<TEntityState>
            : (payload: TCommands[K]) => Promise<TEntityState>;
};

type CompositePkArg<TEntityState, PK> = PK extends readonly (infer K)[]
    ? Pick<TEntityState, Extract<K, keyof TEntityState>>
    : PK extends keyof TEntityState
        ? TEntityState[PK]
        : unknown;

type EntityScopedMirage<TEntityState, TEntityCommands, InjectedCount extends number = 1> = ScopedMirageCommandMap<TEntityState, TEntityCommands, InjectedCount> & ReadonlyDeep<TEntityState>;

type ListScopedMirage<TEntityState, TEntityCommands, PK> =
    ReadonlyArray<EntityScopedMirage<TEntityState, TEntityCommands, InjectedArgCount<PK>>> &
    ((pk: CompositePkArg<TEntityState, PK>) => EntityScopedMirage<TEntityState, TEntityCommands, InjectedArgCount<PK>>);

type MapKnownKeys<TEntry> = TEntry extends { knownKeys?: readonly (infer K)[] }
    ? Extract<K, string>
    : string;

type MapScopedMirage<TEntityState, TEntityCommands, Keys extends string> =
    Readonly<Record<Keys, EntityScopedMirage<TEntityState, TEntityCommands, 1>>> &
    Record<string, EntityScopedMirage<TEntityState, TEntityCommands, 1>> &
    EntityScopedMirage<TEntityState, TEntityCommands, 1>;

type MountedMirageProps<TState, Registry extends AggregateEntityRegistry> = {
    [K in keyof Registry & keyof TState]: Registry[K] extends { kind: 'list'; entity: infer EP; pk: infer PK }
        ? ListScopedMirage<EntityStateOf<Extract<EP, EntityPackage<any, any, any, any, any, any, any>>>, EntityCommandsOf<Extract<EP, EntityPackage<any, any, any, any, any, any, any>>>, PK>
        : Registry[K] extends { kind: 'map'; entity: infer EP }
            ? MapScopedMirage<
                EntityStateOf<Extract<EP, EntityPackage<any, any, any, any, any, any, any>>>,
                EntityCommandsOf<Extract<EP, EntityPackage<any, any, any, any, any, any, any>>>,
                MapKnownKeys<Registry[K]>
            >
            : Registry[K] extends { kind: 'valueObject' }
                ? ReadonlyDeep<TState[K]>
                : never;
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
export type Mirage<TState, M extends Record<string, any> = any, Registry extends AggregateEntityRegistry = {}> = 
    MirageCommandMap<TState, M> & Omit<ReadonlyDeep<TState>, keyof MountedMirageProps<TState, Registry>> & MountedMirageProps<TState, Registry> & {
        readonly state: ReadonlyDeep<TState>;
        dispatch: (command: any) => Promise<TState>;
        subscribe: (listener: (state: TState) => void) => () => void;
    };

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
        public builder: BuiltAggregate<S, any, any, any>,
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

type BuiltAggregateCommands<T> = T extends BuiltAggregate<any, infer M, any, any> ? M : Record<string, any>;
type BuiltAggregateState<T> = T extends BuiltAggregate<infer S, any, any, any> ? S : never;
type BuiltAggregateRegistry<T> = T extends BuiltAggregate<any, any, any, infer R> ? R : {};

export function createMirage<BA extends BuiltAggregate<any, any, any, any>>(
    builder: BA,
    id: string,
    setup?: MirageOptions & { snapshot?: BuiltAggregateState<BA>; events?: Event[] }
): Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>> {

    const state = setup?.events?.reduce((acc, ev) => builder.apply(acc, ev), setup?.snapshot ?? builder.initialState) ?? (setup?.snapshot ?? builder.initialState);
    const core = new MirageCore(builder, id, state, setup?.contract, setup?.strict);
    const mounts = builder.mounts || {};

    const singularize = (value: string) => value.endsWith('s') ? value.slice(0, -1) : value;

    const toCommandName = (path: string[]) => path.reduce(
        (acc, p, i) => acc + (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)),
        ''
    );

    const getMountForRoot = (rootProp: string): MountMetadata | undefined => mounts[rootProp];

    const selectFromList = (mountName: string, mount: MountMetadata, rawPk: unknown): InvocationContext => {
        if (Array.isArray(mount.pk)) {
            if (typeof rawPk !== 'object' || rawPk === null) {
                throw new Error(`Composite key for "${mountName}" must be an object containing: ${mount.pk.join(', ')}`);
            }

            const keyObject: Record<string, unknown> = {};
            mount.pk.forEach((part) => {
                keyObject[part] = (rawPk as Record<string, unknown>)[part];
            });

            return {
                idsPayload: { ...keyObject },
                packPrefix: mount.pk.map((part) => keyObject[part]),
                entityPk: keyObject
            };
        }

        const scalarPk = typeof mount.pk === 'string' ? mount.pk : 'id';
        const keyName = `${singularize(mountName)}Id`;
        return {
            idsPayload: {
                id: rawPk,
                [scalarPk]: rawPk,
                [keyName]: rawPk,
                [`${mountName}Id`]: rawPk
            },
            packPrefix: [rawPk]
        };
    };

    const selectFromListEntity = (mountName: string, mount: MountMetadata, entity: any): InvocationContext | undefined => {
        if (!entity || typeof entity !== 'object') {
            return undefined;
        }

        if (Array.isArray(mount.pk)) {
            const keyObject: Record<string, unknown> = {};
            mount.pk.forEach((part) => {
                keyObject[part] = entity[part];
            });
            return selectFromList(mountName, mount, keyObject);
        }

        const scalarPk = typeof mount.pk === 'string' ? mount.pk : 'id';
        return selectFromList(mountName, mount, entity[scalarPk]);
    };

    const selectFromMap = (mountName: string, rawKey: string): InvocationContext => {
        const keyName = `${singularize(mountName)}Key`;
        return {
            idsPayload: {
                key: rawKey,
                [keyName]: rawKey,
                [`${mountName}Key`]: rawKey
            },
            packPrefix: [rawKey]
        };
    };

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
                const value = Reflect.get(target, prop);
                if (Object.isFrozen(target)) {
                    return value;
                }
                return makeReadonlyProxy(value);
            },
            set() {
                throw new Error('Cannot mutate properties directly');
            },
            deleteProperty() {
                throw new Error('Cannot mutate properties directly');
            }
        });
    };

    const invokeByPath = (commandPath: string[], args: unknown[], context: InvocationContext): Promise<BuiltAggregateState<BA>> => {
        const commandName = toCommandName(commandPath);
        const creator = (builder.commandCreators as any)[commandName];
        if (typeof creator !== 'function') {
            throw new Error('Command ' + commandName + ' not found on commandCreators.');
        }

        const cmdDef = builder.pure?.commandProcessors?.[commandName] as any;
        const isPacked = !!cmdDef && typeof cmdDef !== 'function' && typeof cmdDef.pack === 'function';

        let callArgs: unknown[];
        if (isPacked) {
            callArgs = [...context.packPrefix, ...args];
        } else {
            const firstArg = args[0];
            let payload = firstArg;
            if (typeof payload === 'object' && payload !== null) {
                payload = { ...context.idsPayload, ...(payload as Record<string, unknown>) };
            } else if (payload !== undefined) {
                if (Object.keys(context.idsPayload).length > 0) {
                    payload = { value: payload, ...context.idsPayload };
                }
            } else if (Object.keys(context.idsPayload).length > 0) {
                payload = { ...context.idsPayload };
            }
            callArgs = [payload];
        }

        const cmd = creator(...callArgs);

        if (context.entityPk && cmd && typeof cmd.payload === 'object' && cmd.payload !== null) {
            cmd.payload = { ...(cmd.payload as Record<string, unknown>), __entityPk: context.entityPk };
        }

        return core.dispatch(cmd);
    };

    const makeDeepProxy = (statePath: string[], commandPath: string[], context: InvocationContext): any => {
        return new Proxy(function() {}, {
            get(target, prop) {
                if (commandPath.length === 0) {
                    if (prop === 'state') return makeReadonlyProxy(core.state);
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

                const currentTarget = resolvePath(statePath);
                if (currentTarget && typeof currentTarget === 'object' && prop in currentTarget) {
                    const value = (currentTarget as any)[prop];

                    if (Array.isArray(value)) {
                        const mount = statePath.length === 0 ? getMountForRoot(prop) : undefined;
                        if (mount?.kind === 'list') {
                            return makeCollectionProxy([...statePath, prop], [mount.commandPrefix], mount, context);
                        }

                        const legacyListMount: MountMetadata = {
                            kind: 'list',
                            commandPrefix: prop,
                            statePath: [...statePath, prop],
                            pk: 'id'
                        };
                        return makeCollectionProxy([...statePath, prop], [...commandPath, prop], legacyListMount, context);
                    }

                    if (typeof value === 'object' && value !== null) {
                        const mount = statePath.length === 0 ? getMountForRoot(prop) : undefined;
                        if (mount?.kind === 'valueObject') {
                            return makeReadonlyProxy(value);
                        }
                        if (mount?.kind === 'map') {
                            return makeMapProxy([...statePath, prop], [mount.commandPrefix], mount, context);
                        }
                        return makeDeepProxy([...statePath, prop], [...commandPath, prop], context);
                    }

                    if (typeof value === 'function' && Array.isArray(currentTarget)) {
                        return value.bind(currentTarget);
                    }

                    return value;
                }

                return makeDeepProxy([...statePath, prop], [...commandPath, prop], context);
            },

            apply(target, thisArg, args) {
                return invokeByPath(commandPath, args, context);
            },

            set() {
                throw new Error('Cannot mutate properties directly');
            },

            deleteProperty() {
                throw new Error('Cannot mutate properties directly');
            }
        });
    };

    const makeEntityMirageProxy = (
        collectionPath: string[],
        commandPrefixPath: string[],
        selection: InvocationContext
    ): any => {
        return new Proxy({}, {
            get(target, prop) {
                if (typeof prop !== 'string') return Reflect.get(target, prop);
                if (prop === 'then') return undefined;

                const collection = resolvePath(collectionPath);
                const entity = Array.isArray(collection)
                    ? collection.find((candidate: any) => {
                        if (selection.entityPk) {
                            return Object.keys(selection.entityPk).every((k) => String(candidate?.[k]) === String(selection.entityPk?.[k]));
                        }
                        const id = (selection.idsPayload as Record<string, unknown>).id;
                        return candidate?.id === id || candidate?.id === Number(id);
                    })
                    : undefined;

                // Merge state properties
                if (entity && prop in entity) {
                    return makeReadonlyProxy(entity[prop]);
                }

                // If not in state, assume it's a command creator builder
                return makeDeepProxy([...collectionPath, prop], [...commandPrefixPath, prop], selection);
            },
            set() {
                throw new Error('Cannot mutate properties directly');
            }
        });
    };

    const makeCollectionProxy = (
        collectionPath: string[],
        commandPrefixPath: string[],
        mount: MountMetadata,
        context: InvocationContext
    ): any => {
        const fn = function(pkValue: string | number | Record<string, unknown>) {
            const selection = selectFromList(collectionPath[collectionPath.length - 1], mount, pkValue);
            return makeEntityMirageProxy(
                collectionPath,
                commandPrefixPath,
                {
                    idsPayload: { ...context.idsPayload, ...selection.idsPayload },
                    packPrefix: [...context.packPrefix, ...selection.packPrefix],
                    entityPk: selection.entityPk
                }
            );
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

                if (!isNaN(Number(prop))) {
                    const entity = collection[Number(prop)];
                    const selection = selectFromListEntity(collectionPath[collectionPath.length - 1], mount, entity);
                    if (!selection) {
                        return makeReadonlyProxy(entity);
                    }
                    return makeEntityMirageProxy(
                        collectionPath,
                        commandPrefixPath,
                        {
                            idsPayload: { ...context.idsPayload, ...selection.idsPayload },
                            packPrefix: [...context.packPrefix, ...selection.packPrefix],
                            entityPk: selection.entityPk
                        }
                    );
                }

                if (typeof (collection as any)[prop] === 'function') {
                    return (collection as any)[prop].bind(collection);
                }

                return makeDeepProxy([...collectionPath, prop], [...commandPrefixPath, prop], context);
            },
            set() {
                throw new Error('Cannot mutate collection directly');
            }
        });
    };

    const makeMapItemProxy = (
        mapPath: string[],
        commandPrefixPath: string[],
        mapKey: string,
        context: InvocationContext
    ) => {
        const selection = selectFromMap(mapPath[mapPath.length - 1], mapKey);
        const scopedContext: InvocationContext = {
            idsPayload: { ...context.idsPayload, ...selection.idsPayload },
            packPrefix: [...context.packPrefix, ...selection.packPrefix]
        };

        return new Proxy({}, {
            get(target, prop) {
                if (typeof prop !== 'string') return Reflect.get(target, prop);
                if (prop === 'then') return undefined;

                const mapObject = resolvePath(mapPath);
                const entity = mapObject && typeof mapObject === 'object' ? mapObject[mapKey] : undefined;

                if (entity && typeof entity === 'object' && prop in entity) {
                    return makeReadonlyProxy(entity[prop]);
                }

                return makeDeepProxy([...mapPath, mapKey, prop], [...commandPrefixPath, prop], scopedContext);
            },
            set() {
                throw new Error('Cannot mutate properties directly');
            },
            deleteProperty() {
                throw new Error('Cannot mutate properties directly');
            }
        });
    };

    const makeMapProxy = (
        mapPath: string[],
        commandPrefixPath: string[],
        mount: MountMetadata,
        context: InvocationContext
    ) => {
        return new Proxy({}, {
            get(target, prop) {
                if (prop === 'then') return undefined;

                const mapObject = resolvePath(mapPath) || {};

                if (typeof prop !== 'string') {
                    if (prop === Symbol.iterator) {
                        return Object.values(mapObject)[Symbol.iterator].bind(Object.values(mapObject));
                    }
                    return Reflect.get(target, prop);
                }

                if (['set', 'delete'].includes(prop)) {
                    return () => { throw new Error('Cannot mutate map directly'); };
                }

                if (prop in mapObject || (mount.knownKeys || []).includes(prop)) {
                    return makeMapItemProxy(mapPath, commandPrefixPath, prop, context);
                }

                return makeDeepProxy([...mapPath, prop], [...commandPrefixPath, prop], context);
            },
            set() {
                throw new Error('Cannot mutate properties directly');
            },
            deleteProperty() {
                throw new Error('Cannot mutate properties directly');
            }
        });
    };

    return makeDeepProxy([], [], { idsPayload: {}, packPrefix: [] }) as Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>>;
}

export function createLegacyAggregateBridge<S, M extends Record<string, any>, Registry extends AggregateEntityRegistry = {}>(mirage: Mirage<S, M, Registry>) {
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
