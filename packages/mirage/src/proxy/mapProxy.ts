import { singular } from '@redemeine/aggregate';
import { createReadonlyDeepProxy } from '@redemeine/kernel';
import type { MountMetadata, InvocationContext } from '../mirage.types';
import type { ProxyContext } from './proxyContext';

export const selectFromMap = (mountName: string, rawKey: string): InvocationContext => {
    const keyName = `${singular(mountName)}Key`;
    return {
        idsPayload: {
            key: rawKey,
            [keyName]: rawKey,
            [`${mountName}Key`]: rawKey
        },
        packPrefix: [rawKey]
    };
};

const makeMapItemProxy = (
    mapPath: string[],
    commandPrefixPath: string[],
    mapKey: string,
    context: InvocationContext,
    ctx: ProxyContext
) => {
    const selection = selectFromMap(mapPath[mapPath.length - 1]!, mapKey);
    const scopedContext: InvocationContext = {
        idsPayload: { ...context.idsPayload, ...selection.idsPayload },
        packPrefix: [...context.packPrefix, ...selection.packPrefix]
    };

    return new Proxy({}, {
        get(target, prop) {
            if (typeof prop !== 'string') return Reflect.get(target, prop);
            if (prop === 'then') return undefined;

            const mapObject = ctx.resolvePath(mapPath);
            const entity = mapObject && typeof mapObject === 'object' ? mapObject[mapKey] : undefined;

            if (entity && typeof entity === 'object' && prop in entity) {
                return createReadonlyDeepProxy(entity[prop]);
            }

            return ctx.makeDeepProxy([...mapPath, mapKey, prop], [...commandPrefixPath, prop], scopedContext);
        },
        set() {
            throw new Error('Cannot mutate properties directly');
        },
        deleteProperty() {
            throw new Error('Cannot mutate properties directly');
        }
    });
};

export const makeMapProxy = (
    mapPath: string[],
    commandPrefixPath: string[],
    mount: MountMetadata,
    context: InvocationContext,
    ctx: ProxyContext
) => {
    return new Proxy({}, {
        get(target, prop) {
            if (prop === 'then') return undefined;

            const mapObject = ctx.resolvePath(mapPath) || {};

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
                return makeMapItemProxy(mapPath, commandPrefixPath, prop, context, ctx);
            }

            return ctx.makeDeepProxy([...mapPath, prop], [...commandPrefixPath, prop], context);
        },
        set() {
            throw new Error('Cannot mutate properties directly');
        },
        deleteProperty() {
            throw new Error('Cannot mutate properties directly');
        }
    });
};
