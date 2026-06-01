import { createReadonlyDeepProxy } from '@redemeine/kernel';
import { bindContext, isMirageContextBinding, MirageContextSymbol } from '@redemeine/aggregate';
import type { ReadonlyDeep } from '@redemeine/kernel';
import type { InvocationContext } from '../mirage.types';
import type { ProxyContext } from './proxyContext';
import { findListMountForEntity, selectFromListEntity, makeEntityMirageProxy } from './collectionProxy';
import { findEntityInCollection } from './entityCache';
import { isValidPropAccess } from './proxyGuards';

const roleCommandNamesCache = new WeakMap<object, string[]>();

export const getRoleCommandNames = (role: unknown): string[] => {
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

export const resolveEntityFromSelection = (collectionPath: string[], selection: InvocationContext, ctx: ProxyContext) => {
    const collection = ctx.resolvePath(collectionPath);
    if (!Array.isArray(collection)) {
        return undefined;
    }

    return findEntityInCollection(collection, selection, ctx.core.version);
};

export const makeReadonlyWrappedArray = <T>(items: T[]): ReadonlyArray<T> => {
    return new Proxy(items, {
        get(target, prop) {
            if (!isValidPropAccess(prop)) {
                if (prop === Symbol.iterator) {
                    return target[Symbol.iterator].bind(target);
                }
                return Reflect.get(target, prop);
            }

            if (!isNaN(Number(prop))) {
                return target[Number(prop)];
            }

            // SAFETY: accessing array methods dynamically by string prop name
            const value = (target as unknown as Record<string, unknown>)[prop];
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
    // SAFETY: baseProxy is an opaque Proxy object accessed dynamically by property name
    baseProxy: any,
    collectionPath: string[],
    selection: InvocationContext,
    commandNames: string[],
    ctx: ProxyContext
) => {
    const allowedCommands = new Set(commandNames);

    return new Proxy({}, {
        get(target, prop) {
            if (typeof prop !== 'string') {
                return Reflect.get(target, prop);
            }

            if (prop === '__proto__' || prop === 'constructor' || prop === 'prototype') return undefined;
            if (prop === 'then') return undefined;

            const entity = resolveEntityFromSelection(collectionPath, selection, ctx);
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

const wrapEntityWithRole = (entity: Record<string, unknown>, role: unknown, context: InvocationContext, ctx: ProxyContext) => {
    const resolved = findListMountForEntity(entity, ctx.mounts);
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
        scopedSelection,
        ctx
    );

    const commandNames = getRoleCommandNames(role);
    return makeRoleScopedEntityProxy(baseEntityMirage, [...mount.statePath], scopedSelection, commandNames, ctx);
};

const makeSelectedCollectionProxy = (entities: Record<string, unknown>[], context: InvocationContext, ctx: ProxyContext): unknown => {
    const getEntityMirageAt = (index: number) => {
        const entity = entities[index];
        if (!entity || typeof entity !== 'object') {
            return undefined;
        }

        const resolved = findListMountForEntity(entity, ctx.mounts);
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
            },
            ctx
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

            if (!isValidPropAccess(prop)) {
                if (prop === Symbol.iterator) {
                    return target[Symbol.iterator].bind(target);
                }
                return Reflect.get(target, prop);
            }

            if (!isNaN(Number(prop))) {
                return createReadonlyDeepProxy(target[Number(prop)]);
            }

            // SAFETY: accessing array methods dynamically by string prop name
            const value = (target as unknown as Record<string, unknown>)[prop];
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

export const wrapSelectorResult = (result: unknown, context: InvocationContext, ctx: ProxyContext) => {
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
        // SAFETY: MirageContextSymbol accessor returns opaque binding object with runtime-determined shape
        const bound: any = (result as any)[MirageContextSymbol];

        if (bound.kind === 'single') {
            if (Array.isArray(bound.data)) {
                return makeReadonlyWrappedArray(bound.data.map((item: Record<string, unknown>) => wrapEntityWithRole(item, bound.role, context, ctx)));
            }
            return wrapEntityWithRole(bound.data, bound.role, context, ctx);
        }

        if (!Array.isArray(bound.data)) {
            throw new Error('bindContext polymorphic binding expects an array of data items.');
        }

        const wrapped = bound.data.map((item: Record<string, unknown>) => {
            const discriminatorValue = getPathValue(item, bound.discriminatorKey);
            const role = bound.roleMap?.[String(discriminatorValue)];
            if (!role) {
                throw new Error(`No role mapping found for discriminator value "${String(discriminatorValue)}".`);
            }
            return wrapEntityWithRole(item, role, context, ctx);
        });

        return makeReadonlyWrappedArray(wrapped);
    }

    if (Array.isArray(result)) {
        return makeSelectedCollectionProxy(result, context, ctx);
    }
    return createReadonlyDeepProxy(result);
};

export const invokeSelector = (
    selectorName: string,
    args: unknown[],
    context: InvocationContext,
    ctx: ProxyContext
) => {
    const selector = ctx.selectors[selectorName];
    if (typeof selector !== 'function') {
        throw new Error('Selector ' + selectorName + ' not found on selectors.');
    }

    const stateView = createReadonlyDeepProxy(ctx.core.state);
    const shouldInjectUtils = selector.length >= args.length + 2;
    const result = shouldInjectUtils
        ? selector(stateView, { bindContext }, ...args)
        : selector(stateView, ...args);

    return wrapSelectorResult(result, context, ctx);
};
