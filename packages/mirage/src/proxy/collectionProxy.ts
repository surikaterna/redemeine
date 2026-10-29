import type { MountMetadata, InvocationContext } from '../mirage.types';
import type { ProxyContext } from './proxyContext';
import { findEntityInCollection } from './entityCache';
import { readProperty } from '../runtimeDefinition';
import { readonlyArrayMember, readonlyObjectMember, readonlyTraps, readonlyValue } from './readonlyView';
import { isSelectedDescendant } from './selectedCommandContext';
import { commandMetadata } from '@redemeine/aggregate';
import { nestedCollection } from './nestedCollection';

export function isStaticListCommand(builder: object, name: string, mount: MountMetadata, depth = 1): boolean {
  const registration = commandMetadata(builder, name);
  const target = registration?.targets.at(-1);
  return !!registration?.isStatic && registration.targets.length === depth
    && mount.kind === 'list' && target?.kind === 'list'
    && target.statePath.length === mount.statePath.length && target.statePath.every((part, index) => part === mount.statePath[index]);
}

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
  return { idsPayload: { [key]: value },
    packPrefix: [value], selectedMount: mount, ...(key === 'id' ? {} : { entityPk: { [key]: value } }) };
}

export function selectFromListEntity(name: string, mount: MountMetadata, entity: unknown): InvocationContext {
  return selectFromList(name, mount, Array.isArray(mount.pk) ? entity : readProperty(entity, typeof mount.pk === 'string' ? mount.pk : 'id'));
}

export function makeEntityMirageProxy(path: string[], prefix: string[], selection: InvocationContext, ctx: ProxyContext): unknown {
  const resolveState = () => {
    const collection = selection.resolveCollection ? selection.resolveCollection() : ctx.resolvePath(path);
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
      if (Object.hasOwn(entity, property)) return nestedCollection(property, path, prefix, context, ctx) ?? readonlyValue(readProperty(entity, property));
      if (!Object.hasOwn(ctx.builder.commandCreators, ctx.toCommandName([...prefix, property]))) return undefined;
      if (selection.selectedMount && isSelectedDescendant(ctx.toCommandName([...prefix, property]), ctx.builder, selection.selectedMount, selection.ancestors?.length ?? 0)) return undefined;
      return ctx.makeDeepProxy([...path, property], [...prefix, property], context);
    }
  });
}

export function makeCollectionProxy(path: string[], prefix: string[], mount: MountMetadata, context: InvocationContext, ctx: ProxyContext): unknown {
  const collection = () => context.resolveCollection ? context.resolveCollection() : ctx.resolvePath(path);
  const select = (key: unknown) => {
    const selected = selectFromList(path.at(-1)!, mount, key);
    return makeEntityMirageProxy(path, prefix, { ...selected,
      ancestors: context.ancestors, resolveCollection: context.resolveCollection,
      idsPayload: { ...context.idsPayload, ...selected.idsPayload }, packPrefix: [...context.packPrefix, ...selected.packPrefix] }, ctx);
  };
  const items = () => {
    const entries = collection();
    if (!Array.isArray(entries)) throw new TypeError(`Expected list at ${path.join('.')}`);
    return entries.map(entity => {
      const selected = selectFromListEntity(path.at(-1)!, mount, entity);
      return makeEntityMirageProxy(path, prefix, { ...selected,
        ancestors: context.ancestors, resolveCollection: context.resolveCollection,
        idsPayload: { ...context.idsPayload, ...selected.idsPayload }, packPrefix: [...context.packPrefix, ...selected.packPrefix] }, ctx);
    });
  };
  return new Proxy(select, {
    ...readonlyTraps,
    get(_target, property) {
      if (property === 'then') return undefined;
      if (typeof property === 'string' && mount.commandNames?.includes(property)
        && isStaticListCommand(ctx.builder, ctx.toCommandName([...prefix, property]), mount, (context.ancestors?.length ?? 0) + 1)) {
        return (...args: unknown[]) => ctx.invokeByPath([...prefix, property], args, { idsPayload: {}, packPrefix: [],
          ancestors: context.ancestors, collectionCall: true });
      }
      if (property === Symbol.isConcatSpreadable) return true;
      if (property === 'length') {
        const entries = collection();
        return Array.isArray(entries) ? entries.length : 0;
      }
      return readonlyArrayMember(items(), property);
    }
  });
}
