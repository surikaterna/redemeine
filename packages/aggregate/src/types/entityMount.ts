import type { EntityPackage } from '../createEntity';

/** Canonical definition — all other usages must reference this. */
export type MountedStructureKind = 'list' | 'map' | 'valueObject' | 'valueObjectList' | 'valueObjectMap';

export type MountedStructureMetadata = {
    kind: MountedStructureKind;
    commandPrefix: string;
    statePath: string[];
    pk?: string | readonly string[] | undefined;
    knownKeys?: readonly string[] | undefined;
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
    eventNameOverrides?: Record<string, string>;
    commandNameOverrides?: Record<string, string>;
    /** @deprecated Use eventNameOverrides */
    eventOverrides?: Record<string, string>;
    /** @deprecated Use commandNameOverrides */
    commandOverrides?: Record<string, string>;
};

export type EntityListOptions<PK extends string | readonly string[] = string | readonly string[]> = {
    pk?: PK;
};

export type EntityMapOptions<K extends string = string> = {
    knownKeys?: readonly K[];
};

export type EntityRegistryListEntry<T extends EntityPackage<any, any, any, any, any, any>, PK extends string | readonly string[]> = {
    kind: 'list';
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
