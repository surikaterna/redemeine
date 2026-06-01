import type { ReadonlyDeep } from '@redemeine/kernel';
import type { EntityPackage, AggregateEntityRegistry } from '@redemeine/aggregate';
import type { MirageContextPolymorphicBinding, MirageContextSingleBinding } from '@redemeine/aggregate';
import type { DispatchResult, MirageCommandMap } from './core';

// SAFETY: conditional type inference requires `any` in extends positions to correctly extract generic params
type EntityStateOf<T> = T extends EntityPackage<infer ES, any, any, any, any, any, any> ? ES : never;
type EntityCommandsOf<T> = T extends EntityPackage<any, any, any, any, infer C, any, any> ? C : never;

// SAFETY: tuple manipulation utilities require `any` for extends constraints on variadic positions
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

export type EntityScopedMirage<TEntityState, TEntityCommands, InjectedCount extends number = 1> = ScopedMirageCommandMap<TEntityState, TEntityCommands, InjectedCount> & ReadonlyDeep<TEntityState>;

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

export type SelectorCollectionMirage<TEntity, Registry extends AggregateEntityRegistry> =
    ReadonlyArray<ReadonlyDeep<TEntity>> & {
        first: () => AnyMountedEntityMirage<Registry> | undefined;
        at: (index: number) => AnyMountedEntityMirage<Registry> | undefined;
    };

type SelectorUtils = { bindContext: typeof import('@redemeine/aggregate').bindContext };

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

type IsBroadRecord<T> = string extends keyof T ? true : false;

type MirageSelectorMap<TState, Sel extends Record<string, any>, Registry extends AggregateEntityRegistry> = {
    [K in keyof Sel]: Sel[K] extends (...args: any[]) => any
    ? (...args: SelectorPublicArgs<TState, Sel[K]>) => SelectorResultMirage<SelectorRawResult<TState, Sel[K]>, Registry>
        : never;
};

type RootMirageSelectorMap<
    TState,
    M extends Record<string, any>,
    Registry extends AggregateEntityRegistry,
    Sel extends Record<string, any>
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
export type Mirage<TState, M extends Record<string, any> = any, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, any> = {}> = 
    MirageCommandMap<TState, M> & Omit<ReadonlyDeep<TState>, keyof MountedMirageProps<TState, Registry>> & MountedMirageProps<TState, Registry> & RootMirageSelectorMap<TState, M, Registry, Sel>;
