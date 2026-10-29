import type { EntityPackage } from '../createEntity';

export type CommandRegistration = { kind: 'list' | 'map'; pk: string | readonly string[]; mountName: string };
export type RegisteredCommands<C, R extends CommandRegistration> = {
    [K in keyof C]: Omit<C[K], '__registration'> & { readonly __registration: R };
};
export type ReplaceCommandMap<Previous, Next> = { [K in keyof Previous as K extends keyof Next ? never : K]: Previous[K] } & Next;
type CommandsOfEntry<E> = [E] extends [never] ? {} : E extends { entity: { commands: infer C } } ? C : {};
type ReplaceCommands<T, C> = Omit<T, 'commands'> & { commands: C };
/** Selection follows the last mount; surviving commands retain their own registration. */
export type MountRegistry<Registry, Name extends string, T extends { commands: object }, R extends CommandRegistration, Entry> =
    { [K in keyof Registry as K extends Name ? never : K]: Registry[K] } & { [K in Name]: Omit<Entry, 'entity'> & {
        entity: ReplaceCommands<T, Omit<CommandsOfEntry<K extends keyof Registry ? Registry[K] : never>, keyof T['commands']> & RegisteredCommands<T['commands'], R>>;
    } };

export type EntityCommandTarget = Readonly<Pick<MountedStructureMetadata, 'kind' | 'pk' | 'commandPrefix'>> & { readonly statePath: readonly string[]; readonly initialState?: object };
export type EntityCommandTargets = Record<string, readonly EntityCommandTarget[]>;
export type ResolvedCommandTargets = Readonly<Record<string, readonly (Readonly<Omit<EntityCommandTarget, 'statePath'>> & {
    readonly statePath: readonly string[];
})[]>>;

/** Canonical definition — all other usages must reference this. */
export type MountedStructureKind = 'list' | 'map' | 'valueObject' | 'valueObjectList' | 'valueObjectMap';

export type MountedStructureMetadata = {
    kind: MountedStructureKind;
    semanticName?: string | undefined;
    commandPrefix: string;
    statePath: string[];
    pk?: string | readonly string[] | undefined;
    knownKeys?: readonly string[] | undefined;
    /** Runtime identity for explicit Mirage selector bindings. */
    entity?: object | undefined;
    commandNames?: readonly string[] | undefined;
    getRoleCommandNames?: ((role: object) => readonly string[]) | undefined;
    commandTargets?: EntityCommandTargets | undefined;
    eventTargets?: EntityCommandTargets | undefined;
};

export type MountedEntityPackage = {
    name: string;
    kind: MountedStructureKind;
    component?: EntityPackage<unknown, string> | undefined;
    mountOverrides?: EntityMountOverrides | undefined;
    pk?: string | readonly string[] | undefined;
    knownKeys?: readonly string[] | undefined;
};

export type EntityMountOverrides = {
    semanticName?: string;
    eventNameOverrides?: Record<string, string>;
    commandNameOverrides?: Record<string, string>;
};

/** An optional semantic override cannot guarantee either its value or the default. */
export type MountSemanticName<Default extends string, Options> = Options extends unknown
    ? 'semanticName' extends keyof Options
        ? Options extends { semanticName: infer Name extends string } ? Name : string
        : Default
    : never;

export type EntityListOptions<PK extends string | readonly string[] = string | readonly string[]> = {
    pk?: PK;
};

export type EntityMapOptions<K extends string = string> = {
    knownKeys?: readonly K[];
};

export type EntityRegistryListEntry<T extends EntityPackage<any, any, any, any, any, any>, PK extends string | readonly string[], SemanticName extends string = T['name']> = {
    kind: 'list';
    semanticName: SemanticName;
    entity: T;
    pk: PK;
};

export type EntityRegistryMapEntry<T extends EntityPackage<any, any, any, any, any, any>, Keys extends string = string> = {
    kind: 'map';
    entity: T;
    knownKeys?: readonly Keys[];
};

export type EntityRegistryValueObjectEntry = {
    kind: 'valueObject';
};

export type EntityRegistryValueObjectListEntry = {
    kind: 'valueObjectList';
};

export type EntityRegistryValueObjectMapEntry = {
    kind: 'valueObjectMap';
};

export type AggregateEntityRegistry = Record<string, EntityRegistryListEntry<EntityPackage<any, any, any, any, any, any>, string | readonly string[]> | EntityRegistryMapEntry<EntityPackage<any, any, any, any, any, any>, string> | EntityRegistryValueObjectEntry | EntityRegistryValueObjectListEntry | EntityRegistryValueObjectMapEntry>;
