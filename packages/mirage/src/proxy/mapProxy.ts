import { singular } from '@redemeine/aggregate';
import type { MountMetadata, InvocationContext } from '../mirage.types';
import type { ProxyContext } from './proxyContext';
import { readProperty } from '../runtimeDefinition';
import { readonlyObjectMember, readonlyTraps, readonlyValue } from './readonlyView';

function makeMapItemProxy(path: string[], prefix: string[], key: string, context: InvocationContext, ctx: ProxyContext): unknown {
  const name = path.at(-1)!;
  const resolveState = () => {
    const value = readProperty(ctx.resolvePath(path), key);
    if (!value || typeof value !== 'object') throw new Error(`Entity not found in ${name}.${key}`);
    return value;
  };
  const selection: InvocationContext = { idsPayload: { ...context.idsPayload, key, [`${singular(name)}Key`]: key, [`${name}Key`]: key },
    packPrefix: [...context.packPrefix, key], resolveState };
  return new Proxy({}, {
    ...readonlyTraps,
    get(_target, property) {
      const protocol = readonlyObjectMember(property);
      if (protocol) return protocol;
      if (typeof property !== 'string' || property === 'then') return undefined;
      const entity = resolveState();
      if (Object.hasOwn(entity, property)) return readonlyValue(readProperty(entity, property));
      if (!Object.hasOwn(ctx.builder.commandCreators, ctx.toCommandName([...prefix, property]))) return undefined;
      return ctx.makeDeepProxy([...path, key, property], [...prefix, property], selection);
    }
  });
}

export function makeMapProxy(path: string[], prefix: string[], _mount: MountMetadata, context: InvocationContext, ctx: ProxyContext): unknown {
  const iterate = function* () {
    const keys = Object.keys(ctx.resolvePath(path) ?? {});
    for (const key of keys) yield makeMapItemProxy(path, prefix, key, context, ctx);
  };
  return new Proxy({}, {
    ...readonlyTraps,
    get(_target, property) {
      if (property === Symbol.iterator) return iterate;
      if (typeof property !== 'string') return readonlyObjectMember(property);
      const map = ctx.resolvePath(path);
      if (!map || typeof map !== 'object' || !Object.hasOwn(map, property)) return readonlyObjectMember(property);
      return makeMapItemProxy(path, prefix, property, context, ctx);
    },
    ownKeys: () => Object.keys(ctx.resolvePath(path) ?? {}),
    getOwnPropertyDescriptor: (_target, property) => {
      const map = ctx.resolvePath(path);
      return map && typeof map === 'object' && Object.hasOwn(map, property) ? { enumerable: true, configurable: true } : undefined;
    }
  });
}
