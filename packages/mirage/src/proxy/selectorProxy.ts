import { readonlySelectorResult } from '../stateViews';
import { isMirageContextBinding, MirageContextSymbol } from '@redemeine/aggregate';
import type { InvocationContext, MountMetadata } from '../mirage.types';
import type { ProxyContext } from './proxyContext';
import { selectFromListEntity, makeEntityMirageProxy } from './collectionProxy';
import { invoke, readProperty } from '../runtimeDefinition';
import { readonlyArrayMember, readonlyTraps } from './readonlyView';

function resolveMount(role: unknown, explicit: unknown, ctx: ProxyContext): [string, MountMetadata] {
  const mounts = Object.entries(ctx.mounts);
  const candidates = mounts.filter(([name, mount]) =>
    mount.kind === 'list' && (explicit === undefined ? mount.entity === role : name === explicit));
  if (candidates.length !== 1) {
    throw new Error('Missing or ambiguous selector mount; bindContext(data, Entity, { mount: "name" }) must identify one list');
  }
  if (mounts.some(([, mount]) => mount.entity === role) && candidates[0]![1].entity !== role) {
    throw new Error('Explicit selector mount does not match the declared entity');
  }
  return candidates[0]!;
}

function bindEntity(entity: unknown, role: unknown, mountName: unknown, context: InvocationContext, ctx: ProxyContext): unknown {
  if (entity === undefined || entity === null) return entity;
  const [name, mount] = resolveMount(role, mountName, ctx);
  const selected = selectFromListEntity(name, mount, entity);
  const entityProxy = makeEntityMirageProxy(mount.statePath, [mount.commandPrefix], { ...selected,
    idsPayload: { ...context.idsPayload, ...selected.idsPayload }, packPrefix: [...context.packPrefix, ...selected.packPrefix] }, ctx);
  return role === mount.entity ? entityProxy : restrictRole(entityProxy, role, mount);
}

function restrictRole(value: unknown, role: unknown, mount: MountMetadata): unknown {
  if (!value || typeof value !== 'object') throw new Error('Invalid entity proxy');
  if (!role || typeof role !== 'object' || !mount.getRoleCommandNames) throw new Error('Missing selector role metadata');
  const allowed = new Set(mount.getRoleCommandNames(role));
  if ([...allowed].some(name => !mount.commandNames?.includes(name))) throw new Error('Selector role has commands absent from its explicit mount');
  return new Proxy(value, { ...readonlyTraps, get(target, property) {
    if (typeof property === 'string' && mount.commandNames?.includes(property) && !allowed.has(property)) return undefined;
    return Reflect.get(target, property);
  } });
}

function boundArray(items: unknown[]): readonly unknown[] {
  return new Proxy(items, { ...readonlyTraps, get: (_target, property) => readonlyArrayMember(items, property) });
}

function wrapSelectorResult(result: unknown, context: InvocationContext, ctx: ProxyContext): unknown {
  if (!isMirageContextBinding(result)) return readonlySelectorResult(result);
  const binding: unknown = readProperty(result, MirageContextSymbol);
  const data = readProperty(binding, 'data');
  if (readProperty(binding, 'kind') === 'single') {
    const wrap = (entity: unknown) => bindEntity(entity, readProperty(binding, 'role'), readProperty(binding, 'mount'), context, ctx);
    return Array.isArray(data) ? boundArray(data.map(wrap)) : wrap(data);
  }
  if (!Array.isArray(data)) throw new Error('Polymorphic selector binding requires an array');
  const discriminator = readProperty(binding, 'discriminatorKey');
  if (typeof discriminator !== 'string') throw new Error('Invalid selector discriminator');
  return boundArray(data.map(item => {
    const value = discriminator.split('.').reduce<unknown>((current, part) => readProperty(current, part), item);
    const role = readProperty(readProperty(binding, 'roleMap'), String(value));
    if (!role) throw new Error(`No role mapping found for discriminator value "${String(value)}".`);
    return bindEntity(item, role, readProperty(binding, 'mount'), context, ctx);
  }));
}

export function invokeSelector(name: string, args: unknown[], context: InvocationContext, ctx: ProxyContext): unknown {
  const stateView = ctx.core.stateView();
  // Utilities are captured by Aggregate's selector factory; function arity is not a calling convention.
  const result = invoke(readProperty(ctx.selectors, name), undefined, [stateView, ...args]);
  return wrapSelectorResult(result, context, ctx);
}
