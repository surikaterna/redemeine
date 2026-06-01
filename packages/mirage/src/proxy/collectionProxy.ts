import { singular } from '@redemeine/aggregate';
import { createReadonlyDeepProxy } from '@redemeine/kernel';
import type { MountMetadata, InvocationContext } from '../mirage.types';
import type { ProxyContext } from './proxyContext';
import { findEntityInCollection } from './entityCache';
import { isValidPropAccess } from './proxyGuards';

export const selectFromList = (mountName: string, mount: MountMetadata, rawPk: unknown): InvocationContext => {
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
    const keyName = `${singular(mountName)}Id`;
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

export const selectFromListEntity = (mountName: string, mount: MountMetadata, entity: any): InvocationContext | undefined => {
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

export const isListMount = (mount: MountMetadata | undefined): mount is MountMetadata & { kind: 'list' } => {
    return !!mount && mount.kind === 'list';
};

export const findListMountForEntity = (entity: any, mounts: Record<string, MountMetadata>): [string, MountMetadata & { kind: 'list' }] | undefined => {
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

export const makeEntityMirageProxy = (
    collectionPath: string[],
    commandPrefixPath: string[],
    selection: InvocationContext,
    ctx: ProxyContext
): any => {
    return new Proxy({}, {
        get(target, prop) {
            if (typeof prop !== 'string') return Reflect.get(target, prop);
            if (prop === '__proto__' || prop === 'constructor' || prop === 'prototype') return undefined;
            if (prop === 'then') return undefined;

            const collection = ctx.resolvePath(collectionPath);
            const entity = Array.isArray(collection)
                ? findEntityInCollection(collection, selection, ctx.core.version)
                : undefined;

            if (entity && prop in entity) {
                return createReadonlyDeepProxy(entity[prop]);
            }

            return ctx.makeDeepProxy([...collectionPath, prop], [...commandPrefixPath, prop], selection);
        },
        set() {
            throw new Error('Cannot mutate properties directly');
        }
    });
};

export const makeCollectionProxy = (
    collectionPath: string[],
    commandPrefixPath: string[],
    mount: MountMetadata,
    context: InvocationContext,
    ctx: ProxyContext
): any => {
    const fn = function(pkValue: string | number | Record<string, unknown>) {
        const selection = selectFromList(collectionPath[collectionPath.length - 1]!, mount, pkValue);
        return makeEntityMirageProxy(
            collectionPath,
            commandPrefixPath,
            {
                idsPayload: { ...context.idsPayload, ...selection.idsPayload },
                packPrefix: [...context.packPrefix, ...selection.packPrefix],
                entityPk: selection.entityPk
            },
            ctx
        );
    };

    return new Proxy(fn, {
        get(target, prop) {
            if (prop === 'then') return undefined;
            
            const collection = ctx.resolvePath(collectionPath) || [];

            if (typeof prop !== 'string') {
                if (prop === Symbol.iterator) return collection[Symbol.iterator].bind(collection);
                return Reflect.get(target, prop);
            }

            if (prop === '__proto__' || prop === 'constructor' || prop === 'prototype') return undefined;

            if (['set', 'push', 'pop', 'splice'].includes(prop)) {
                return () => { throw new Error('Cannot mutate collection directly'); };
            }

            if (prop === 'length') return collection.length;

            if (!isNaN(Number(prop))) {
                const entity = collection[Number(prop)];
                const selection = selectFromListEntity(collectionPath[collectionPath.length - 1]!, mount, entity);
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
                    },
                    ctx
                );
            }

            if (typeof (collection as any)[prop] === 'function') {
                return (collection as any)[prop].bind(collection);
            }

            return ctx.makeDeepProxy([...collectionPath, prop], [...commandPrefixPath, prop], context);
        },
        set() {
            throw new Error('Cannot mutate collection directly');
        }
    });
};
