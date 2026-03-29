import { Command, Event, AggregateHooks, CommandInterceptorContext, EventInterceptorContext, PluginExtensions, PluginIntents, RedemeinePlugin, RedemeinePluginHookError } from './types';
import { Contract } from './Contract';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import { createReadonlyDeepProxy } from './utils/readonlyProxy';
import type { EntityPackage } from './createEntity';
import type { AggregateEntityRegistry } from './createAggregate';
import { bindContext, isMirageContextBinding, MirageContextSymbol, type MirageContextPolymorphicBinding, type MirageContextSingleBinding } from './bindContext';

type MountKind = 'list' | 'map' | 'valueObject' | 'valueObjectList' | 'valueObjectMap';

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
export interface BuiltAggregate<S, M, E = any, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, any> = {}, TPlugins extends PluginExtensions = {}> {
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
    selectors: Sel;
    metadata?: {
        commands?: Record<string, { meta?: Record<string, unknown> }>;
        events?: Record<string, { meta?: Record<string, unknown> }>;
    };
    plugins?: RedemeinePlugin<TPlugins>[];
    mounts?: Record<string, MountMetadata>;
    __registryType?: Registry;
}

/**
 * A mapped record of executable live commands bound directly to the aggregate instance.
 * These methods dispatch commands and return the mutated state.
 */
type IsBroadRecord<T> = string extends keyof T ? true : false;
type DispatchResult<T> = T | Promise<T>;

export type MirageCommandMap<S, M> = IsBroadRecord<M> extends true
    ? {}
    : {
        [K in keyof M]: M[K] extends { args: infer Args, payload: infer P }
            ? (...args: Args extends any[] ? Args : never) => DispatchResult<S>
            : [M[K]] extends [void] | [undefined] | [never]
                ? () => DispatchResult<S>
                : (payload: M[K]) => DispatchResult<S>;
    };

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
        ? (...args: DropFirstN<Args extends any[] ? Args : [], InjectedCount>) => DispatchResult<TEntityState>
        : [TCommands[K]] extends [void] | [undefined] | [never]
            ? () => DispatchResult<TEntityState>
            : (payload: TCommands[K]) => DispatchResult<TEntityState>;
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
            : Registry[K] extends { kind: 'valueObject' | 'valueObjectList' | 'valueObjectMap' }
                ? ReadonlyDeep<TState[K]>
                : never;
};

type AnyMountedEntityMirage<Registry extends AggregateEntityRegistry> = {
    [K in keyof Registry]: Registry[K] extends { kind: 'list'; entity: infer EP; pk: infer PK }
        ? EntityScopedMirage<
            EntityStateOf<Extract<EP, EntityPackage<any, any, any, any, any, any, any>>>,
            EntityCommandsOf<Extract<EP, EntityPackage<any, any, any, any, any, any, any>>>,
            InjectedArgCount<PK>
        >
        : Registry[K] extends { kind: 'map'; entity: infer EP }
            ? EntityScopedMirage<
                EntityStateOf<Extract<EP, EntityPackage<any, any, any, any, any, any, any>>>,
                EntityCommandsOf<Extract<EP, EntityPackage<any, any, any, any, any, any, any>>>,
                1
            >
            : never;
}[keyof Registry];

type SelectorCollectionMirage<TEntity, Registry extends AggregateEntityRegistry> =
    ReadonlyArray<ReadonlyDeep<TEntity>> & {
        first: () => AnyMountedEntityMirage<Registry> | undefined;
        at: (index: number) => AnyMountedEntityMirage<Registry> | undefined;
    };

type SelectorUtils = { bindContext: typeof bindContext };

type SelectorPublicArgs<TState, TSelector> =
    TSelector extends (state: ReadonlyDeep<TState>, utils: SelectorUtils, ...args: infer Args) => any
        ? Args
        : TSelector extends (state: ReadonlyDeep<TState>, ...args: infer Args) => any
            ? Args
            : never;

type SelectorRawResult<TState, TSelector> =
    TSelector extends (state: ReadonlyDeep<TState>, utils: SelectorUtils, ...args: any[]) => infer R
        ? R
        : TSelector extends (state: ReadonlyDeep<TState>, ...args: any[]) => infer R
            ? R
            : never;

type PathValue<T, P extends string> =
    P extends `${infer K}.${infer Rest}`
        ? K extends keyof T
            ? PathValue<T[K], Rest>
            : never
        : P extends keyof T
            ? T[P]
            : never;

type SetPathValue<T, P extends string, V> =
    P extends `${infer K}.${infer Rest}`
        ? K extends keyof T
            ? Omit<T, K> & { [Key in K]: SetPathValue<T[K], Rest, V> }
            : T & { [Key in K]: SetPathValue<{}, Rest, V> }
        : P extends keyof T
            ? Omit<T, P> & { [Key in P]: V }
            : T & { [Key in P]: V };

type ArrayLikeElement<T> =
    T extends readonly (infer E)[]
        ? E
        : T extends { readonly [index: number]: infer E; length: number }
            ? E
            : never;

type IsArrayLike<T> = ArrayLikeElement<T> extends never ? false : true;

type ContextBoundSingleMirage<TData, TRole> = IsArrayLike<TData> extends true
    ? ReadonlyArray<EntityScopedMirage<ArrayLikeElement<TData>, EntityCommandsOf<TRole>, 1>>
    : EntityScopedMirage<TData, EntityCommandsOf<TRole>, 1>;

type RoleFromDiscriminator<
    TRoleMap extends Record<string, EntityPackage<any, any, any, any, any, any, any>>,
    TDisc extends string
> = TDisc extends keyof TRoleMap ? TRoleMap[TDisc] : never;

type DiscriminatorValues<E, TKey extends string> =
    Extract<PathValue<E, TKey>, string>;

type MatchingDiscriminatorValues<
    E,
    TKey extends string,
    TRoleMap extends Record<string, EntityPackage<any, any, any, any, any, any, any>>
> = Extract<DiscriminatorValues<E, TKey>, keyof TRoleMap & string>;

type PolyRoleMirageForDiscriminator<
    E,
    TKey extends string,
    TRoleMap extends Record<string, EntityPackage<any, any, any, any, any, any, any>>,
    TDisc extends string
> = RoleFromDiscriminator<TRoleMap, TDisc> extends infer TRole
    ? TRole extends EntityPackage<any, any, any, any, any, any, any>
        ? EntityScopedMirage<
            E extends object ? SetPathValue<E, TKey, TDisc> : E,
            EntityCommandsOf<TRole>,
            1
        >
        : never
    : never;

type ContextBoundPolyMirage<
    TData,
    TKey extends string,
    TRoleMap extends Record<string, EntityPackage<any, any, any, any, any, any, any>>
> = IsArrayLike<TData> extends true
    ? ReadonlyArray<
        ArrayLikeElement<TData> extends infer E
        ? MatchingDiscriminatorValues<E, TKey, TRoleMap> extends infer D
            ? D extends string
                ? PolyRoleMirageForDiscriminator<E, TKey, TRoleMap, D>
                : never
            : never
        : never
      >
    : never;

type SelectorResultMirage<R, Registry extends AggregateEntityRegistry> =
    R extends MirageContextSingleBinding<infer TData, infer TRole>
        ? ContextBoundSingleMirage<TData, TRole>
        : R extends MirageContextPolymorphicBinding<infer TData, infer TKey, infer TRoleMap>
            ? ContextBoundPolyMirage<
                TData,
                Extract<TKey, string>,
                Extract<TRoleMap, Record<string, EntityPackage<any, any, any, any, any, any, any>>>
            >
            : R extends ReadonlyArray<infer E>
                ? SelectorCollectionMirage<E, Registry>
                : R;

type MirageSelectorMap<TState, Sel extends Record<string, any>, Registry extends AggregateEntityRegistry> = {
    [K in keyof Sel]: Sel[K] extends (...args: any[]) => any
    ? (...args: SelectorPublicArgs<TState, Sel[K]>) => SelectorResultMirage<SelectorRawResult<TState, Sel[K]>, Registry>
        : never;
};

type MirageReservedKeys = 'state' | 'selectors' | 'dispatch' | 'subscribe';

type RootMirageSelectorMap<
    TState,
    M extends Record<string, any>,
    Registry extends AggregateEntityRegistry,
    Sel extends Record<string, any>
> = IsBroadRecord<M> extends true
    ? Omit<
                MirageSelectorMap<TState, Sel, Registry>,
        keyof ReadonlyDeep<TState> | keyof MountedMirageProps<TState, Registry> | MirageReservedKeys
      >
    : Omit<
                MirageSelectorMap<TState, Sel, Registry>,
        keyof ReadonlyDeep<TState> | keyof MountedMirageProps<TState, Registry> | keyof M | MirageReservedKeys
      >;

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
export type Mirage<TState, M extends Record<string, any> = any, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, any> = {}> = 
    MirageCommandMap<TState, M> & Omit<ReadonlyDeep<TState>, keyof MountedMirageProps<TState, Registry>> & MountedMirageProps<TState, Registry> & RootMirageSelectorMap<TState, M, Registry, Sel> & {
        readonly state: ReadonlyDeep<TState>;
        readonly selectors: MirageSelectorMap<TState, Sel, Registry>;
        dispatch: (command: any) => DispatchResult<TState>;
        subscribe: (listener: (state: TState) => void) => () => void;
    };

/**
 * A private symbol used to access internal dispatch mechanisms (MirageCore) 
 * without polluting the public aggregate API methods.
 */
export const MirageCoreSymbol = Symbol('MirageCore');

const hasHydrateEventPlugins = (plugins: RedemeinePlugin<any>[]): boolean => {
    return plugins.some((plugin) => typeof plugin.onHydrateEvent === 'function');
};

const assertPluginHasKey = (plugin: RedemeinePlugin<any>): void => {
    if (!plugin.key || typeof plugin.key !== 'string') {
        throw new Error('Invalid plugin configuration: plugin.key is required and must be a non-empty string.');
    }
};

const wrapPluginHookFailure = (
    plugin: RedemeinePlugin<any>,
    hook: 'onBeforeCommand' | 'onHydrateEvent' | 'onBeforeAppend' | 'onAfterCommit',
    aggregateId: string,
    cause: unknown
): RedemeinePluginHookError => {
    assertPluginHasKey(plugin);
    return new RedemeinePluginHookError({
        pluginKey: plugin.key,
        hook,
        aggregateId,
        cause
    });
};

const hydrateStateFromEvents = <S>(
    builder: BuiltAggregate<S, any, any, any>,
    baseState: S,
    events: Event[]
): S => {
    return events.reduce((acc, ev) => builder.apply(acc, ev), baseState);
};

const hydrateStateFromEventsWithPlugins = async <S>(
    builder: BuiltAggregate<S, any, any, any>,
    aggregateId: string,
    baseState: S,
    events: Event[],
    plugins: RedemeinePlugin<any>[]
): Promise<S> => {
    let state = baseState;
    const eventMetaRegistry = builder.metadata?.events || {};

    for (const event of events) {
        const ctx: EventInterceptorContext<{}, unknown> = {
            pluginKey: '',
            aggregateId,
            eventType: event.type,
            payload: event.payload,
            meta: eventMetaRegistry[event.type]?.meta
        };

        for (const plugin of plugins) {
            assertPluginHasKey(plugin);
            if (typeof plugin.onHydrateEvent === 'function') {
                ctx.pluginKey = plugin.key;
                try {
                    const nextPayload = await plugin.onHydrateEvent(ctx);
                    if (nextPayload !== undefined) {
                        ctx.payload = nextPayload;
                    }
                } catch (error) {
                    throw wrapPluginHookFailure(plugin, 'onHydrateEvent', aggregateId, error);
                }
            }
        }

        event.payload = ctx.payload;
        state = builder.apply(state, event);
    }

    return state;
};

/**
 * Configuration options strictly passed during the instantiation of a Mirage instance.
 */
export interface MirageOptions<TPlugins extends PluginExtensions = {}> {
    contract?: Contract;
    strict?: boolean;
    plugins?: RedemeinePlugin<TPlugins>[];
}

/**
 * The internal core controller of a Mirage instance.
 * Tracks the uncommitted events, current version, and executes the core command routing.
 */
export class MirageCore<S> {
    private pendingResults: { events: Event[]; intents: Record<string, unknown> } = {
        events: [],
        intents: {}
    };
    public version: number = 0;
    private listeners: ((state: S) => void)[] = [];
    private plugins: RedemeinePlugin<any>[];
    private hasBeforeCommandPlugins: boolean;

    public get uncommitted(): Event[] {
        return this.pendingResults.events;
    }

    private getResultIntents(events: Event[]): PluginIntents<any> {
        const intents = (events as Event[] & { __intents?: Record<string, unknown> }).__intents;
        return intents && typeof intents === 'object' ? intents : {} as PluginIntents<any>;
    }

    constructor(
        public builder: BuiltAggregate<S, any, any, any>,
        public id: string,
        public state: S,
        public contract?: Contract,
        public strict: boolean = false,
        plugins: RedemeinePlugin<any>[] = []
    ) {
        this.plugins = plugins;
        this.plugins.forEach(assertPluginHasKey);
        this.hasBeforeCommandPlugins = plugins.some((plugin) => typeof plugin.onBeforeCommand === 'function');
    }

    private async runBeforeCommandInterceptors(command: Command<any, string>): Promise<void> {
        const commandMetaRegistry = this.builder.metadata?.commands || {};
        const ctx: CommandInterceptorContext<{}, unknown> = {
            pluginKey: '',
            aggregateId: this.id,
            commandType: command.type,
            payload: command.payload,
            meta: commandMetaRegistry[command.type]?.meta
        };

        for (const plugin of this.plugins) {
            if (typeof plugin.onBeforeCommand === 'function') {
                ctx.pluginKey = plugin.key;
                try {
                    await plugin.onBeforeCommand(ctx);
                } catch (error) {
                    throw wrapPluginHookFailure(plugin, 'onBeforeCommand', this.id, error);
                }
            }
        }
    }

    private processAndApply(command: Command<any, string>): S {
        if (this.builder.hooks?.onBeforeCommand) {
            this.builder.hooks.onBeforeCommand(command, createReadonlyDeepProxy(this.state) as any);
        }

        if (this.contract) {
            try {
                this.contract.validateCommand(command.type, command.payload);
            } catch (err: any) {
                if (err.message.includes('schema not found')) {
                    if (this.strict) throw err;
                    console.warn(err.message);
                } else {
                    throw err;
                }
            }
        }

        const events = this.builder.process(this.state, command);

        if (this.builder.hooks?.onAfterCommand) {
            this.builder.hooks.onAfterCommand(command, events, createReadonlyDeepProxy(this.state) as any);
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
            this.pendingResults.events.push(ev);
            if (this.builder.hooks?.onEventApplied) {
                this.builder.hooks.onEventApplied(ev, createReadonlyDeepProxy(this.state) as any);
            }
        }

        this.pendingResults.intents = {
            ...this.pendingResults.intents,
            ...this.getResultIntents(events)
        };

        this.version++;
        this.notify();
        return this.state;
    }

    private async dispatchWithPlugins(command: Command<any, string>): Promise<S> {
        await this.runBeforeCommandInterceptors(command);

        if (this.builder.hooks?.onBeforeCommand) {
            this.builder.hooks.onBeforeCommand(command, createReadonlyDeepProxy(this.state) as any);
        }

        if (this.contract) {
            try {
                this.contract.validateCommand(command.type, command.payload);
            } catch (err: any) {
                if (err.message.includes('schema not found')) {
                    if (this.strict) throw err;
                    console.warn(err.message);
                } else {
                    throw err;
                }
            }
        }

        const events = this.builder.process(this.state, command);

        if (this.builder.hooks?.onAfterCommand) {
            this.builder.hooks.onAfterCommand(command, events, createReadonlyDeepProxy(this.state) as any);
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
            this.pendingResults.events.push(ev);
            if (this.builder.hooks?.onEventApplied) {
                this.builder.hooks.onEventApplied(ev, createReadonlyDeepProxy(this.state) as any);
            }
        }

        this.pendingResults.intents = {
            ...this.pendingResults.intents,
            ...this.getResultIntents(events)
        };

        this.version++;
        this.notify();
        return this.state;
    }

    public getPendingResults(): { events: Event[]; intents: Record<string, unknown> } {
        return {
            events: [...this.pendingResults.events],
            intents: { ...this.pendingResults.intents }
        };
    }

    public clearPendingResults(): void {
        this.pendingResults = {
            events: [],
            intents: {}
        };
    }

    public subscribe(listener: (state: S) => void) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    public notify() {
        this.listeners.forEach(l => l(this.state));
    }

    public dispatch(cmd: any): DispatchResult<S> {
        const command = cmd as Command<any, string>;

        if (this.hasBeforeCommandPlugins) {
            return this.dispatchWithPlugins(command);
        }

        return this.processAndApply(command);
    }
}

type BuiltAggregateCommands<T> = T extends BuiltAggregate<any, infer M, any, any> ? M : Record<string, any>;
type BuiltAggregateState<T> = T extends BuiltAggregate<infer S, any, any, any> ? S : never;
type BuiltAggregateRegistry<T> = T extends BuiltAggregate<any, any, any, infer R, any> ? R : {};
type BuiltAggregateSelectors<T> = T extends BuiltAggregate<any, any, any, any, infer Sel> ? Sel : {};
type BuiltAggregatePlugins<T> = T extends BuiltAggregate<any, any, any, any, any, infer P> ? P : {};

export function createMirage<BA extends BuiltAggregate<any, any, any, any, any>>(
    builder: BA,
    id: string
): Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>;
export function createMirage<BA extends BuiltAggregate<any, any, any, any, any>>(
    builder: BA,
    id: string,
    setup: (MirageOptions<BuiltAggregatePlugins<BA>> & { snapshot?: BuiltAggregateState<BA>; events?: undefined }) | undefined
): Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>;
export function createMirage<BA extends BuiltAggregate<any, any, any, any, any>>(
    builder: BA,
    id: string,
    setup: (Omit<MirageOptions<BuiltAggregatePlugins<BA>>, 'plugins'> & { snapshot?: BuiltAggregateState<BA>; events?: Event[] }) | undefined
): Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>;
export function createMirage<BA extends BuiltAggregate<any, any, any, any, any>>(
    builder: BA,
    id: string,
    setup: MirageOptions<BuiltAggregatePlugins<BA>> & { snapshot?: BuiltAggregateState<BA>; events: Event[]; plugins: RedemeinePlugin<any>[] }
): Promise<Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>>;
export function createMirage<BA extends BuiltAggregate<any, any, any, any, any>>(
    builder: BA,
    id: string,
    setup: MirageOptions<BuiltAggregatePlugins<BA>> & { snapshot?: BuiltAggregateState<BA>; events: Event[] }
): Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>> | Promise<Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>>;
export function createMirage<BA extends BuiltAggregate<any, any, any, any, any>>(
    builder: BA,
    id: string,
    setup?: MirageOptions<BuiltAggregatePlugins<BA>> & { snapshot?: BuiltAggregateState<BA>; events?: Event[] }
): Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>> | Promise<Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>> {

    const makeMirage = (state: BuiltAggregateState<BA>, plugins: RedemeinePlugin<any>[]): Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>> => {

    const core = new MirageCore(builder, id, state, setup?.contract, setup?.strict, plugins);
    const mounts = builder.mounts || {};
    const selectors = (builder.selectors || {}) as Record<string, (state: ReadonlyDeep<BuiltAggregateState<BA>>, ...args: any[]) => any>;

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

    // Removed local proxy implementation

    const invokeByPath = (commandPath: string[], args: unknown[], context: InvocationContext): DispatchResult<BuiltAggregateState<BA>> => {
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

    const isListMount = (mount: MountMetadata | undefined): mount is MountMetadata & { kind: 'list' } => !!mount && mount.kind === 'list';

    const findListMountForEntity = (entity: any): [string, MountMetadata & { kind: 'list' }] | undefined => {
        if (!entity || typeof entity !== 'object') {
            return undefined;
        }

        for (const [mountName, mount] of Object.entries(mounts)) {
            if (!isListMount(mount)) continue;

            if (Array.isArray(mount.pk)) {
                if (mount.pk.every((k) => k in entity)) {
                    return [mountName, mount];
                }
                continue;
            }

            const scalarPk = typeof mount.pk === 'string' ? mount.pk : 'id';
            if (scalarPk in entity) {
                return [mountName, mount];
            }
        }

        return undefined;
    };

    const roleCommandNamesCache = new WeakMap<object, string[]>();

    const getRoleCommandNames = (role: unknown): string[] => {
        if (!role || typeof role !== 'object') {
            return [];
        }

        const cached = roleCommandNamesCache.get(role);
        if (cached) {
            return cached;
        }

        const roleAsEntity = role as { commandFactory?: Function };
        if (typeof roleAsEntity.commandFactory !== 'function') {
            roleCommandNamesCache.set(role, []);
            return [];
        }

        try {
            const fakeEmit = new Proxy({}, { get: () => () => ({ type: '', payload: undefined }) });
            const fakeSelectors = new Proxy({}, { get: () => () => undefined });
            const fakeCommands = new Proxy({}, {
                get: (_target, prop: string) => (payload: unknown) => ({ command: prop, payload })
            });
            const roleCommands = roleAsEntity.commandFactory(fakeEmit, { selectors: fakeSelectors, commands: fakeCommands }) || {};
            const names = Object.keys(roleCommands);
            roleCommandNamesCache.set(role, names);
            return names;
        } catch {
            roleCommandNamesCache.set(role, []);
            return [];
        }
    };

    const resolveEntityFromSelection = (collectionPath: string[], selection: InvocationContext) => {
        const collection = resolvePath(collectionPath);
        if (!Array.isArray(collection)) {
            return undefined;
        }

        return collection.find((candidate: any) => {
            if (selection.entityPk) {
                return Object.keys(selection.entityPk).every((k) => String(candidate?.[k]) === String(selection.entityPk?.[k]));
            }
            const id = (selection.idsPayload as Record<string, unknown>).id;
            return candidate?.id === id || candidate?.id === Number(id);
        });
    };

    const makeReadonlyWrappedArray = <T>(items: T[]): ReadonlyArray<T> => {
        return new Proxy(items, {
            get(target, prop) {
                if (typeof prop !== 'string') {
                    if (prop === Symbol.iterator) {
                        return target[Symbol.iterator].bind(target);
                    }
                    return Reflect.get(target, prop);
                }

                if (!isNaN(Number(prop))) {
                    return target[Number(prop)];
                }

                const value = (target as any)[prop];
                return typeof value === 'function' ? value.bind(target) : value;
            },
            set() {
                throw new Error('Cannot mutate selector collection directly');
            },
            deleteProperty() {
                throw new Error('Cannot mutate selector collection directly');
            }
        });
    };

    const makeRoleScopedEntityProxy = (
        baseProxy: any,
        collectionPath: string[],
        selection: InvocationContext,
        commandNames: string[]
    ) => {
        const allowedCommands = new Set(commandNames);

        return new Proxy({}, {
            get(target, prop) {
                if (typeof prop !== 'string') {
                    return Reflect.get(target, prop);
                }

                if (prop === 'then') return undefined;

                const entity = resolveEntityFromSelection(collectionPath, selection);
                if (entity && typeof entity === 'object' && prop in entity) {
                    return baseProxy[prop];
                }

                if (allowedCommands.has(prop)) {
                    return baseProxy[prop];
                }

                return undefined;
            },
            set() {
                throw new Error('Cannot mutate properties directly');
            },
            deleteProperty() {
                throw new Error('Cannot mutate properties directly');
            }
        });
    };

    const wrapEntityWithRole = (entity: any, role: unknown, context: InvocationContext) => {
        const resolved = findListMountForEntity(entity);
        if (!resolved) {
            throw new Error('bindContext could not resolve a mounted list entity for selector item.');
        }

        const [mountName, mount] = resolved;
        const selection = selectFromListEntity(mountName, mount, entity);
        if (!selection) {
            throw new Error('bindContext could not extract key fields from selector item.');
        }

        const scopedSelection: InvocationContext = {
            idsPayload: { ...context.idsPayload, ...selection.idsPayload },
            packPrefix: [...context.packPrefix, ...selection.packPrefix],
            entityPk: selection.entityPk
        };

        const baseEntityMirage = makeEntityMirageProxy(
            [...mount.statePath],
            [mount.commandPrefix],
            scopedSelection
        );

        const commandNames = getRoleCommandNames(role);
        return makeRoleScopedEntityProxy(baseEntityMirage, [...mount.statePath], scopedSelection, commandNames);
    };

    const makeSelectedCollectionProxy = (entities: any[], context: InvocationContext): any => {
        const getEntityMirageAt = (index: number) => {
            const entity = entities[index];
            if (!entity || typeof entity !== 'object') {
                return undefined;
            }

            const resolved = findListMountForEntity(entity);
            if (!resolved) {
                return undefined;
            }

            const [mountName, mount] = resolved;
            const selection = selectFromListEntity(mountName, mount, entity);
            if (!selection) {
                return undefined;
            }

            return makeEntityMirageProxy(
                [...mount.statePath],
                [mount.commandPrefix],
                {
                    idsPayload: { ...context.idsPayload, ...selection.idsPayload },
                    packPrefix: [...context.packPrefix, ...selection.packPrefix],
                    entityPk: selection.entityPk
                }
            );
        };

        return new Proxy(entities, {
            get(target, prop) {
                if (prop === 'first') {
                    return () => getEntityMirageAt(0);
                }

                if (prop === 'at') {
                    return (index: number) => getEntityMirageAt(index);
                }

                if (typeof prop !== 'string') {
                    if (prop === Symbol.iterator) {
                        return target[Symbol.iterator].bind(target);
                    }
                    return Reflect.get(target, prop);
                }

                if (!isNaN(Number(prop))) {
                    return createReadonlyDeepProxy(target[Number(prop)]);
                }

                const value = (target as any)[prop];
                if (typeof value === 'function') {
                    return value.bind(target);
                }

                return value;
            },
            set() {
                throw new Error('Cannot mutate selector collection directly');
            },
            deleteProperty() {
                throw new Error('Cannot mutate selector collection directly');
            }
        });
    };

    const wrapSelectorResult = (result: unknown, context: InvocationContext) => {
        const getPathValue = (obj: unknown, path: string): unknown => {
            if (!obj || typeof obj !== 'object') {
                return undefined;
            }
            return path.split('.').reduce<unknown>((acc, part) => {
                if (acc && typeof acc === 'object') {
                    return (acc as Record<string, unknown>)[part];
                }
                return undefined;
            }, obj);
        };

        if (isMirageContextBinding(result)) {
            const bound = result[MirageContextSymbol as any];

            if (bound.kind === 'single') {
                if (Array.isArray(bound.data)) {
                    return makeReadonlyWrappedArray(bound.data.map((item) => wrapEntityWithRole(item, bound.role, context)));
                }
                return wrapEntityWithRole(bound.data, bound.role, context);
            }

            if (!Array.isArray(bound.data)) {
                throw new Error('bindContext polymorphic binding expects an array of data items.');
            }

            const wrapped = bound.data.map((item) => {
                const discriminatorValue = getPathValue(item, bound.discriminatorKey);
                const role = bound.roleMap?.[String(discriminatorValue)];
                if (!role) {
                    throw new Error(`No role mapping found for discriminator value "${String(discriminatorValue)}".`);
                }
                return wrapEntityWithRole(item, role, context);
            });

            return makeReadonlyWrappedArray(wrapped);
        }

        if (Array.isArray(result)) {
            return makeSelectedCollectionProxy(result, context);
        }
        return createReadonlyDeepProxy(result);
    };

    const invokeSelector = (selectorName: string, args: unknown[], context: InvocationContext) => {
        const selector = selectors[selectorName];
        if (typeof selector !== 'function') {
            throw new Error('Selector ' + selectorName + ' not found on selectors.');
        }

        const stateView = createReadonlyDeepProxy(core.state);
        const shouldInjectUtils = selector.length >= args.length + 2;
        const result = shouldInjectUtils
            ? selector(stateView, { bindContext }, ...args)
            : selector(stateView, ...args);

        return wrapSelectorResult(result, context);
    };

    const makeSelectorsProxy = (context: InvocationContext): any => {
        return new Proxy({}, {
            get(target, prop) {
                if (typeof prop !== 'string') {
                    return Reflect.get(target, prop);
                }
                if (prop === 'then') return undefined;
                if (!(prop in selectors)) return undefined;
                return (...args: unknown[]) => invokeSelector(prop, args, context);
            },
            set() {
                throw new Error('Cannot mutate selectors directly');
            },
            deleteProperty() {
                throw new Error('Cannot mutate selectors directly');
            }
        });
    };

    const makeDeepProxy = (statePath: string[], commandPath: string[], context: InvocationContext): any => {
        return new Proxy(function() {}, {
            get(target, prop) {
                if (commandPath.length === 0) {
                    if (prop === 'state') return createReadonlyDeepProxy(core.state);
                    if (prop === 'selectors') return makeSelectorsProxy(context);
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

                if (statePath.length === 0 && prop in selectors && !(prop in (builder.commandCreators as Record<string, unknown>))) {
                    return (...args: unknown[]) => invokeSelector(prop, args, context);
                }

                const currentTarget = resolvePath(statePath);
                if (currentTarget && typeof currentTarget === 'object' && prop in currentTarget) {
                    const value = (currentTarget as any)[prop];

                    if (Array.isArray(value)) {
                        const mount = statePath.length === 0 ? getMountForRoot(prop) : undefined;
                        if (mount?.kind === 'valueObjectList') {
                            return createReadonlyDeepProxy(value);
                        }
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
                        if (mount?.kind === 'valueObject' || mount?.kind === 'valueObjectMap') {
                            return createReadonlyDeepProxy(value);
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
                    return createReadonlyDeepProxy(entity[prop]);
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
                        return createReadonlyDeepProxy(entity);
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
                    return createReadonlyDeepProxy(entity[prop]);
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

    return makeDeepProxy([], [], { idsPayload: {}, packPrefix: [] }) as Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>;
    };

    const baseState = setup?.snapshot ?? builder.initialState;
    const setupEvents = setup?.events || [];
    const plugins = [...(builder.plugins || []), ...(setup?.plugins || [])] as RedemeinePlugin<any>[];

    if (setupEvents.length === 0) {
        return makeMirage(baseState, plugins);
    }

    if (!hasHydrateEventPlugins(plugins)) {
        return makeMirage(hydrateStateFromEvents(builder, baseState, setupEvents), plugins);
    }

    return (async () => {
        const hydratedState = await hydrateStateFromEventsWithPlugins(builder, id, baseState, setupEvents, plugins);
        return makeMirage(hydratedState, plugins);
    })();
}

export function createLegacyAggregateBridge<S, M extends Record<string, any>, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, any> = {}>(mirage: Mirage<S, M, Registry, Sel>) {
    const core = (mirage as any)[MirageCoreSymbol] as MirageCore<S>;
    if (!core) {
        throw new Error('Target is not a valid Mirage Instance.');
    }
    return {
        get id() { return core.id; },
        get _state() { return core.state; },
        getVersion: () => core.version,
        clearUncommittedEvents: () => { core.clearPendingResults(); },
        getUncommittedEvents: () => [...core.uncommitted],
    };
}

/**
 * Returns a copy of all uncommitted events currently buffered by a Mirage instance.
 */
export function extractUncommittedEvents<S, M extends Record<string, any>, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, any> = {}>(
    mirage: Mirage<S, M, Registry, Sel>
): Event[] {
    return createLegacyAggregateBridge(mirage).getUncommittedEvents();
}

/**
 * Clears the uncommitted event buffer for a Mirage instance.
 */
export function clearUncommittedEvents<S, M extends Record<string, any>, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, any> = {}>(
    mirage: Mirage<S, M, Registry, Sel>
): void {
    createLegacyAggregateBridge(mirage).clearUncommittedEvents();
}

/**
 * Represents a storage mechanism binding the instantiated aggregate state lifecycle
 * directly to your underlying database representations (Depot).
 * Facilitates hydration (`findById`) and persistence (`save`).
 */
