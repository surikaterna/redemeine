import { singular } from '@redemeine/aggregate';
import type { MountMetadata, InvocationContext } from '../mirage.types';
import type { ProxyContext } from './proxyContext';
import { findEntityInCollection } from './entityCache';
import { readProperty } from '../runtimeDefinition';
import { readonlyArrayMember, readonlyObjectMember, readonlyTraps, readonlyValue } from './readonlyView';

function identityValue(value: unknown, mount: string): string | number | bigint {
  if (typeof value === 'string' || typeof value === 'bigint' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new TypeError(`Missing or invalid primary key for ${mount}`);
}

export function selectFromList(name: string, mount: MountMetadata, raw: unknown): InvocationContext {
  if (Array.isArray(mount.pk)) {
    const identity = Object.fromEntries(mount.pk.map(key => [key, identityValue(readProperty(raw, key), name)]));
    return { idsPayload: identity, packPrefix: mount.pk.map(key => identity[key]), entityPk: identity, selectedMount: mount };
  }
  const key = typeof mount.pk === 'string' ? mount.pk : 'id';
  const value = identityValue(raw, name);
  return { idsPayload: { id: value, [key]: value, [`${singular(name)}Id`]: value, [`${name}Id`]: value },
    packPrefix: [value], selectedMount: mount, ...(key === 'id' ? {} : { entityPk: { [key]: value } }) };
}

export function selectFromListEntity(name: string, mount: MountMetadata, entity: unknown): InvocationContext {
  return selectFromList(name, mount, Array.isArray(mount.pk) ? entity : readProperty(entity, typeof mount.pk === 'string' ? mount.pk : 'id'));
}

export function makeEntityMirageProxy(path: string[], prefix: string[], selection: InvocationContext, ctx: ProxyContext): unknown {
  const resolveState = () => {
    const collection = ctx.resolvePath(path);
    const entity = Array.isArray(collection) ? findEntityInCollection(collection, selection, ctx.core.version) : undefined;
    if (!entity || typeof entity !== 'object') throw new Error(`Entity not found in ${path.join('.')}`);
    return entity;
  };
  resolveState();
  const context = { ...selection, resolveState };
  return new Proxy({}, {
    ...readonlyTraps,
    get(_target, property) {
      const protocol = readonlyObjectMember(property);
      if (protocol) return protocol;
      if (typeof property !== 'string' || property === 'then') return undefined;
      const entity = resolveState();
      if (Object.hasOwn(entity, property)) return readonlyValue(readProperty(entity, property));
      if (!Object.hasOwn(ctx.builder.commandCreators, ctx.toCommandName([...prefix, property]))) return undefined;
      return ctx.makeDeepProxy([...path, property], [...prefix, property], context);
    }
  });
}

export function makeCollectionProxy(path: string[], prefix: string[], mount: MountMetadata, context: InvocationContext, ctx: ProxyContext): unknown {
  const select = (key: unknown) => {
    const selected = selectFromList(path.at(-1)!, mount, key);
    return makeEntityMirageProxy(path, prefix, { ...selected,
      idsPayload: { ...context.idsPayload, ...selected.idsPayload }, packPrefix: [...context.packPrefix, ...selected.packPrefix] }, ctx);
  };
  const items = () => {
    const collection = ctx.resolvePath(path);
    if (!Array.isArray(collection)) throw new TypeError(`Expected list at ${path.join('.')}`);
    return collection.map(entity => {
      const selected = selectFromListEntity(path.at(-1)!, mount, entity);
      return makeEntityMirageProxy(path, prefix, { ...selected,
        idsPayload: { ...context.idsPayload, ...selected.idsPayload }, packPrefix: [...context.packPrefix, ...selected.packPrefix] }, ctx);
    });
  };
  return new Proxy(select, {
    ...readonlyTraps,
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === Symbol.isConcatSpreadable) return true;
      if (property === 'length') {
        const collection = ctx.resolvePath(path);
        return Array.isArray(collection) ? collection.length : 0;
      }
      return readonlyArrayMember(items(), property);
    }
  });
}
