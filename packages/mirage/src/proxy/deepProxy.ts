import { createReadonlyDeepProxy } from '@redemeine/kernel';
import type { BuiltAggregate } from '@redemeine/aggregate';
import type { MountMetadata, InvocationContext, DispatchResult } from '../mirage.types';
import { MirageCoreSymbol } from '../mirage.types';
import type { MirageCore } from '../MirageCore';
import type { ProxyContext } from './proxyContext';
import { makeCollectionProxy, makeEntityMirageProxy } from './collectionProxy';
import { makeMapProxy } from './mapProxy';
import { invokeSelector } from './selectorProxy';
import { isValidPropAccess } from './proxyGuards';

export const createProxyContext = (
    core: MirageCore<any>, // SAFETY: state type erased; proxy accesses state dynamically
    mounts: Record<string, MountMetadata>,
    // SAFETY: selectors have heterogeneous signatures
    selectors: Record<string, (...args: any[]) => any>,
    // SAFETY: BuiltAggregate generic params erased; used for runtime property access
    builder: BuiltAggregate<any, any, any, any>
): ProxyContext => {
    const ctx: ProxyContext = {
        core,
        mounts,
        selectors,
        builder,
        resolvePath,
        toCommandName,
        getMountForRoot,
        invokeByPath: (commandPath, args, context) => invokeByPathImpl(commandPath, args, context, ctx),
        invokeSelector: (name, args, context) => invokeSelector(name, args, context, ctx),
        makeDeepProxy: (statePath, commandPath, context) => makeDeepProxyImpl(statePath, commandPath, context, ctx),
        makeCollectionProxy: (collectionPath, commandPrefixPath, mount, context) => makeCollectionProxy(collectionPath, commandPrefixPath, mount, context, ctx),
        makeMapProxy: (mapPath, commandPrefixPath, mount, context) => makeMapProxy(mapPath, commandPrefixPath, mount, context, ctx),
        makeEntityMirageProxy: (collectionPath, commandPrefixPath, selection) => makeEntityMirageProxy(collectionPath, commandPrefixPath, selection, ctx),
    };

    function resolvePath(path: string[]) {
        let current: unknown = core.state;
        for (const p of path) {
            if (current && typeof current === 'object') {
                current = (current as Record<string, unknown>)[p];
            } else {
                return undefined;
            }
        }
        return current;
    }

    function toCommandName(path: string[]) {
        return path.reduce(
            (acc, p, i) => acc + (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)),
            ''
        );
    }

    function getMountForRoot(rootProp: string): MountMetadata | undefined {
        return mounts[rootProp] as MountMetadata | undefined;
    }

    return ctx;
};

const invokeByPathImpl = (
    commandPath: string[],
    args: unknown[],
    context: InvocationContext,
    ctx: ProxyContext
): DispatchResult<unknown> => {
    const commandName = ctx.toCommandName(commandPath);
    // SAFETY: commandCreators is a dynamic record; key access requires any cast
    const creator = (ctx.builder as any).commandCreators?.[commandName];
    if (typeof creator !== 'function') {
        throw new Error('Command ' + commandName + ' not found on commandCreators.');
    }

    // SAFETY: commandProcessors is a dynamic record with heterogeneous shapes
    const cmdDef = (ctx.builder as any).pure?.commandProcessors?.[commandName] as { pack?: Function } | Function | undefined;
    const isPacked = !!cmdDef && typeof cmdDef !== 'function' && typeof (cmdDef as { pack?: Function }).pack === 'function';

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

    return ctx.core.dispatch(cmd);
};

const makeDeepProxyImpl = (
    statePath: string[],
    commandPath: string[],
    context: InvocationContext,
    ctx: ProxyContext
): unknown => {
    return new Proxy(function() {}, {
        get(target, prop) {
            if (commandPath.length === 0) {
                if (prop === MirageCoreSymbol) return ctx.core;
            }

            if (!isValidPropAccess(prop)) {
                return Reflect.get(target, prop);
            }

            if (prop === '__proto__' || prop === 'constructor' || prop === 'prototype') {
                return undefined;
            }

            if (prop === 'then') return undefined;

            if (["asymmetricMatch", "nodeType", "@@toStringTag", "toJSON", "toString", "valueOf", "inspect"].includes(prop)) {
                return Reflect.get(target, prop);
            }

            if (statePath.length === 0 && prop in ctx.selectors && !(prop in (ctx.builder.commandCreators as Record<string, unknown>))) {
                return (...args: unknown[]) => ctx.invokeSelector(prop, args, context);
            }

            const currentTarget = ctx.resolvePath(statePath);
            if (currentTarget && typeof currentTarget === 'object' && prop in currentTarget) {
                const value = (currentTarget as Record<string, unknown>)[prop];

                if (Array.isArray(value)) {
                    const mount = statePath.length === 0 ? ctx.getMountForRoot(prop) : undefined;
                    if (mount?.kind === 'valueObjectList') {
                        return createReadonlyDeepProxy(value);
                    }
                    if (mount?.kind === 'list') {
                        return ctx.makeCollectionProxy([...statePath, prop], [mount.commandPrefix], mount, context);
                    }
                    return createReadonlyDeepProxy(value);
                }

                if (typeof value === 'object' && value !== null) {
                    const mount = statePath.length === 0 ? ctx.getMountForRoot(prop) : undefined;
                    if (mount?.kind === 'valueObject' || mount?.kind === 'valueObjectMap') {
                        return createReadonlyDeepProxy(value);
                    }
                    if (mount?.kind === 'map') {
                        return ctx.makeMapProxy([...statePath, prop], [mount.commandPrefix], mount, context);
                    }
                    return ctx.makeDeepProxy([...statePath, prop], [...commandPath, prop], context);
                }

                if (typeof value === 'function' && Array.isArray(currentTarget)) {
                    return value.bind(currentTarget);
                }

                return value;
            }

            return ctx.makeDeepProxy([...statePath, prop], [...commandPath, prop], context);
        },

        apply(target, thisArg, args) {
            return ctx.invokeByPath(commandPath, args, context);
        },

        set() {
            throw new Error('Cannot mutate properties directly');
        },

        deleteProperty() {
            throw new Error('Cannot mutate properties directly');
        }
    });
};
