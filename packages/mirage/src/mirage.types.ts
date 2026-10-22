import type { Event, PluginExtensions, RedemeinePlugin, Contract } from '@redemeine/kernel';
import type { AggregateStateView as ReadonlyDeep } from '@redemeine/aggregate';
import type { AggregateEntityRegistry } from '@redemeine/aggregate';
import type { MirageContextPolymorphicBinding, MirageContextSingleBinding } from '@redemeine/aggregate';

export type MountKind = 'list' | 'map' | 'valueObject' | 'valueObjectList' | 'valueObjectMap';

export type MountMetadata = {
    kind: MountKind;
    commandPrefix: string;
    statePath: string[];
    pk?: string | readonly string[] | undefined;
    knownKeys?: readonly string[] | undefined;
    entity?: object | undefined;
    commandNames?: readonly string[] | undefined;
    getRoleCommandNames?: ((role: object) => readonly string[]) | undefined;
};

export type InvocationContext = {
    idsPayload: Record<string, unknown>;
    packPrefix: unknown[];
    entityPk?: Record<string, unknown> | undefined;
    resolveState?: (() => unknown) | undefined;
    selectedMount?: MountMetadata | undefined;
};

export type { BuiltAggregate } from '@redemeine/aggregate';

/**
 * A mapped record of executable live commands bound directly to the aggregate instance.
 * These methods dispatch commands and return the mutated state.
 */
type IsBroadRecord<T> = string extends keyof T ? true : false;
export type DispatchResult<T> = ReadonlyDeep<T> | Promise<ReadonlyDeep<T>>;

export type MirageCommandMap<S, M> = IsBroadRecord<M> extends true
    ? {}
    : {
        [K in keyof M]: M[K] extends { args: infer Args, payload: infer P }
            ? (...args: Args extends unknown[] ? Args : never) => DispatchResult<S>
            : [M[K]] extends [void] | [undefined] | [never]
                ? () => DispatchResult<S>
                : (payload: M[K]) => DispatchResult<S>;
    };

type EntityStateOf<T> = T extends { readonly __stateType?: infer ES } ? ES : never;
type EntityCommandsOf<T> = T extends { commands: infer C } ? C : never;
type EntityShape = { readonly __stateType?: unknown; commands: object };

type DropFirstN<Args extends unknown[], N extends number, Count extends unknown[] = []> =
    Count['length'] extends N
        ? Args
        : Args extends [unknown, ...infer Rest]
            ? DropFirstN<Rest, N, [...Count, unknown]>
            : [];

type InjectedArgCount<PK> = PK extends readonly unknown[] ? PK['length'] : 1;

type ScopedPayloadArgs<Args extends unknown[], Identity extends PropertyKey> = Args extends [infer P]
    ? P extends object
        ? {} extends Omit<P, Identity> ? [payload?: Omit<P, Identity>] : [payload: Omit<P, Identity>]
        : Args
    : Args;

type ScopedMirageCommandMap<TEntityState, TCommands, InjectedCount extends number, Identity extends PropertyKey> = {
    [K in keyof TCommands]: TCommands[K] extends { args: infer Args }
        ? (...args: TCommands[K] extends { form: 'shorthand' }
            ? ScopedPayloadArgs<Args extends unknown[] ? Args : [], Identity>
            : DropFirstN<Args extends unknown[] ? Args : [], InjectedCount>) => DispatchResult<TEntityState>
        : [TCommands[K]] extends [void] | [undefined] | [never]
            ? () => DispatchResult<TEntityState>
            : (payload: TCommands[K]) => DispatchResult<TEntityState>;
};

type CompositePkArg<TEntityState, PK> = PK extends readonly (infer K)[]
    ? Pick<TEntityState, Extract<K, keyof TEntityState>>
    : PK extends keyof TEntityState
        ? TEntityState[PK]
        : unknown;

export type EntityScopedMirage<TEntityState, TEntityCommands, InjectedCount extends number = 1, Identity extends PropertyKey = 'id'> = ScopedMirageCommandMap<TEntityState, TEntityCommands, InjectedCount, Identity> & ReadonlyDeep<TEntityState>;

type Singular<S extends string> = S extends `${infer Stem}s` ? Stem : S;
type ListIdentity<PK, Name extends string> = PK extends readonly (infer K extends string)[] ? K
    : Extract<PK, string> | 'id' | `${Name}Id` | `${Singular<Name>}Id`;
type MapIdentity<Name extends string> = 'key' | `${Name}Key` | `${Singular<Name>}Key`;

type ListScopedMirage<TEntityState, TEntityCommands, PK, Name extends string> =
    ReadonlyArray<EntityScopedMirage<TEntityState, TEntityCommands, InjectedArgCount<PK>, ListIdentity<PK, Name>>> &
    ((pk: CompositePkArg<TEntityState, PK>) => EntityScopedMirage<TEntityState, TEntityCommands, InjectedArgCount<PK>, ListIdentity<PK, Name>>);

type MapKnownKeys<TEntry> = TEntry extends { knownKeys?: readonly (infer K)[] }
    ? Extract<K, string>
    : string;

type MapScopedMirage<TEntityState, TEntityCommands, Keys extends string, Name extends string> = Iterable<EntityScopedMirage<TEntityState, TEntityCommands, 1, MapIdentity<Name>>> & (string extends Keys
    ? Readonly<Record<string, EntityScopedMirage<TEntityState, TEntityCommands, 1, MapIdentity<Name>> | undefined>>
    : Readonly<Record<Keys, EntityScopedMirage<TEntityState, TEntityCommands, 1, MapIdentity<Name>>>>);

type MountedMirageProps<TState, Registry extends AggregateEntityRegistry> = {
    [K in keyof Registry & keyof TState]: Registry[K] extends { kind: 'list'; entity: infer EP; pk: infer PK }
        ? ListScopedMirage<EntityStateOf<EP>, EntityCommandsOf<EP>, PK, Extract<K, string>>
        : Registry[K] extends { kind: 'map'; entity: infer EP }
            ? MapScopedMirage<
                EntityStateOf<EP>,
                EntityCommandsOf<EP>,
                MapKnownKeys<Registry[K]>, Extract<K, string>
            >
            : Registry[K] extends { kind: 'valueObject' | 'valueObjectList' | 'valueObjectMap' }
                ? ReadonlyDeep<TState[K]>
                : never;
};

export type SelectorCollectionMirage<TEntity, Registry extends AggregateEntityRegistry> =
    ReadonlyArray<ReadonlyDeep<TEntity>>;

type SelectorPublicArgs<TState, TSelector> =
    TSelector extends (state: ReadonlyDeep<TState>, ...args: infer Args) => unknown
            ? Args
            : never;

type SelectorRawResult<TState, TSelector> =
    TSelector extends (state: ReadonlyDeep<TState>, ...args: never[]) => infer R
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

type BoundKey<Registry, Role, Mount> = {
    [K in keyof Registry]: Registry[K] extends { kind: 'list'; entity: infer Entity; pk: infer PK }
      ? Mount extends string ? K extends Mount ? PK : never : Role extends Entity ? PK : never : never
}[keyof Registry];
type BoundArgCount<Registry, Role, Mount> = [BoundKey<Registry, Role, Mount>] extends [never] ? 1
    : InjectedArgCount<BoundKey<Registry, Role, Mount>>;
type BoundIdentity<Registry, Role, Mount> = {
    [K in keyof Registry]: Registry[K] extends { kind: 'list'; entity: infer Entity; pk: infer PK }
      ? Mount extends string ? K extends Mount ? ListIdentity<PK, Extract<K, string>> : never
        : Role extends Entity ? ListIdentity<PK, Extract<K, string>> : never : never
}[keyof Registry];

type ContextBoundSingleMirage<TData, TRole, Registry, Mount> = TData extends null | undefined ? TData
    : IsArrayLike<TData> extends true
      ? ReadonlyArray<EntityScopedMirage<ArrayLikeElement<TData>, EntityCommandsOf<TRole>, BoundArgCount<Registry, TRole, Mount>, BoundIdentity<Registry, TRole, Mount>>> & {
          first(): EntityScopedMirage<ArrayLikeElement<TData>, EntityCommandsOf<TRole>, BoundArgCount<Registry, TRole, Mount>, BoundIdentity<Registry, TRole, Mount>> | undefined;
        }
      : EntityScopedMirage<TData, EntityCommandsOf<TRole>, BoundArgCount<Registry, TRole, Mount>, BoundIdentity<Registry, TRole, Mount>>;

type RoleFromDiscriminator<
    TRoleMap extends Record<string, EntityShape>,
    TDisc extends string
> = TDisc extends keyof TRoleMap ? TRoleMap[TDisc] : never;

type DiscriminatorValues<E, TKey extends string> =
    Extract<PathValue<E, TKey>, string>;

type MatchingDiscriminatorValues<
    E,
    TKey extends string,
    TRoleMap extends Record<string, EntityShape>
> = Extract<DiscriminatorValues<E, TKey>, keyof TRoleMap & string>;

type PolyRoleMirageForDiscriminator<
    E,
    TKey extends string,
    TRoleMap extends Record<string, EntityShape>,
    TDisc extends string,
    Registry,
    Mount
> = RoleFromDiscriminator<TRoleMap, TDisc> extends infer TRole
    ? TRole extends EntityShape
        ? EntityScopedMirage<
            E extends object ? SetPathValue<E, TKey, TDisc> : E,
            EntityCommandsOf<TRole>,
            BoundArgCount<Registry, TRole, Mount>, BoundIdentity<Registry, TRole, Mount>
        >
        : never
    : never;

type ContextBoundPolyMirage<
    TData,
    TKey extends string,
    TRoleMap extends Record<string, EntityShape>,
    Registry,
    Mount
> = IsArrayLike<TData> extends true
    ? ReadonlyArray<
        ArrayLikeElement<TData> extends infer E
        ? MatchingDiscriminatorValues<E, TKey, TRoleMap> extends infer D
            ? D extends string
                ? PolyRoleMirageForDiscriminator<E, TKey, TRoleMap, D, Registry, Mount>
                : never
            : never
        : never
      >
    : never;

type SelectorResultMirage<R, Registry extends AggregateEntityRegistry> =
    R extends MirageContextSingleBinding<infer TData, infer TRole, infer Mount>
        ? ContextBoundSingleMirage<TData, TRole, Registry, Mount>
        : R extends MirageContextPolymorphicBinding<infer TData, infer TKey, infer TRoleMap, infer Mount>
            ? ContextBoundPolyMirage<
                TData,
                Extract<TKey, string>,
                Extract<TRoleMap, Record<string, EntityShape>>,
                Registry,
                Mount
            >
            : R extends ReadonlyArray<infer E>
                ? ReadonlyArray<ReadonlyDeep<E>>
                : ReadonlyDeep<R>;

type MirageSelectorMap<TState, Sel extends object, Registry extends AggregateEntityRegistry> = {
    [K in keyof Sel]: Sel[K] extends (...args: never[]) => unknown
    ? (...args: SelectorPublicArgs<TState, Sel[K]>) => SelectorResultMirage<SelectorRawResult<TState, Sel[K]>, Registry>
        : never;
};

type RootMirageSelectorMap<
    TState,
    M extends object,
    Registry extends AggregateEntityRegistry,
    Sel extends object
> = IsBroadRecord<M> extends true
    ? Omit<
                MirageSelectorMap<TState, Sel, Registry>,
        keyof ReadonlyDeep<TState> | keyof MountedMirageProps<TState, Registry>
      >
    : Omit<
                MirageSelectorMap<TState, Sel, Registry>,
        keyof ReadonlyDeep<TState> | keyof MountedMirageProps<TState, Registry> | keyof M
      >;

/**
 * The standard active instantiated aggregate wrapper holding bounded paths.
 */
declare const mirageStateType: unique symbol;
export interface MirageDiagnostics {
    readonly version: number;
    getPendingResults(): { events: Event[]; intents: Record<string, unknown> };
}
/** Type-only identity preserves state inference through helpers; runtime identity is private. */
export type MirageInstance<TState> = {
    readonly [mirageStateType]: TState;
    readonly [MirageCoreSymbol]: MirageDiagnostics;
};
export type Mirage<TState, M extends object = {}, Registry extends AggregateEntityRegistry = {}, Sel extends object = {}> =
    MirageInstance<TState> & MirageCommandMap<TState, M> & Omit<ReadonlyDeep<TState>, keyof MountedMirageProps<TState, Registry>> & MountedMirageProps<TState, Registry> & RootMirageSelectorMap<TState, M, Registry, Sel>;

/**
 * Readonly diagnostics without domain-name collisions; mutable core access stays private.
 */
export const MirageCoreSymbol = Symbol('MirageCore');

export type HydrationEvents<TEvent> = Iterable<TEvent> | AsyncIterable<TEvent>;

/**
 * Configuration options strictly passed during the instantiation of a Mirage instance.
 */
export interface MirageOptions<TPlugins extends PluginExtensions = {}> {
    contract?: Contract;
    strict?: boolean;
    plugins?: RedemeinePlugin<TPlugins>[];
}

export interface MirageSetup<TState, TPlugins extends PluginExtensions = {}> extends MirageOptions<TPlugins> {
    snapshot?: TState | ReadonlyDeep<TState>;
    events?: HydrationEvents<Event>;
    /** Persisted event count represented by the starting state, before replay. Defaults to zero. */
    initialVersion?: number;
}

export type BuiltAggregateCommands<T> = T extends { commandCreators: infer C } ? {
    [K in keyof C]: C[K] extends (...args: infer Args) => infer Cmd
        ? { args: Args; payload: Cmd extends { payload: infer P } ? P : unknown } : never
} : {};
export type BuiltAggregateState<T> = T extends unknown
    ? '__stateType' extends keyof T
        ? T extends { readonly __stateType?: infer S } ? S : never
        : T extends { initialState: infer S } ? S : never
    : never;
export type BuiltAggregateRegistry<T> = T extends { __registryType?: infer R extends AggregateEntityRegistry } ? R : {};
export type BuiltAggregateSelectors<T> = T extends { selectors: infer Sel extends object } ? Sel : {};
export type BuiltAggregatePlugins<T> = T extends { plugins: RedemeinePlugin<infer P>[] } ? P : {};
export type MirageOf<T> = Mirage<BuiltAggregateState<T>, BuiltAggregateCommands<T>, BuiltAggregateRegistry<T>, BuiltAggregateSelectors<T>>;

type KnownKeys<T> = string extends keyof T ? never : keyof T;
type StateKeys<B> = KnownKeys<BuiltAggregateState<B>>;
type CommandKeys<B> = KnownKeys<BuiltAggregateCommands<B>>;
type SelectorKeys<B> = KnownKeys<BuiltAggregateSelectors<B>>;
type ProtocolNames = 'then' | 'toJSON' | 'toString' | 'valueOf' | 'inspect';
type MountCollisionKeys<R> = {
    [K in keyof R]: R[K] extends { entity: infer E }
      ? Extract<KnownKeys<EntityStateOf<E>>, KnownKeys<EntityCommandsOf<E>>>
        | Extract<KnownKeys<EntityStateOf<E>> | KnownKeys<EntityCommandsOf<E>>, ProtocolNames> : never
}[keyof R];
type CollisionKeys<B> = Extract<StateKeys<B>, CommandKeys<B> | SelectorKeys<B>>
  | Extract<CommandKeys<B>, SelectorKeys<B>>
  | Extract<StateKeys<B> | CommandKeys<B> | SelectorKeys<B>, ProtocolNames>
  | MountCollisionKeys<BuiltAggregateRegistry<B>>;
export type NoMirageCollisions<B> = [CollisionKeys<B>] extends [never] ? unknown
  : { readonly __mirageNameCollision: CollisionKeys<B> };
