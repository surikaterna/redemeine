import type { Command } from '@redemeine/kernel';
import type { MountMetadata, InvocationContext } from '../mirage.types';
import { MirageCoreSymbol } from '../mirage.types';
import type { ProxyContext, ProxyCore } from './proxyContext';
import { makeCollectionProxy, makeEntityMirageProxy } from './collectionProxy';
import { makeMapProxy } from './mapProxy';
import { invokeSelector } from './selectorProxy';
import { invoke, readProperty, type MirageBuilder } from '../runtimeDefinition';
import { readonlyObjectMember, readonlyTraps, readonlyValue } from './readonlyView';

export function createProxyContext(core: ProxyCore, mounts: Record<string, MountMetadata>, selectors: object, builder: MirageBuilder): ProxyContext {
  const context: ProxyContext = {
    core, mounts, selectors, builder,
    resolvePath: path => path.reduce<unknown>((value, key) => readProperty(value, key), core.state),
    toCommandName: path => path.map((part, index) => index ? part.charAt(0).toUpperCase() + part.slice(1) : part).join(''),
    getMountForRoot: name => mounts[name],
    invokeByPath: (path, args, selection) => invokeByPath(path, args, selection, context),
    invokeSelector: (name, args, selection) => invokeSelector(name, args, selection, context),
    makeDeepProxy: (path, commands, selection) => makeDeepProxy(path, commands, selection, context),
    makeCollectionProxy: (path, commands, mount, selection) => makeCollectionProxy(path, commands, mount, selection, context),
    makeMapProxy: (path, commands, mount, selection) => makeMapProxy(path, commands, mount, selection, context),
    makeEntityMirageProxy: (path, commands, selection) => makeEntityMirageProxy(path, commands, selection, context)
  };
  return context;
}

function commandArguments(definition: unknown, args: unknown[], context: InvocationContext): unknown[] {
  if (typeof definition !== 'function' && typeof readProperty(definition, 'pack') === 'function') return [...context.packPrefix, ...args];
  const first = args[0];
  if (first !== null && typeof first === 'object') return [{ ...context.idsPayload, ...first }];
  if (Object.keys(context.idsPayload).length) return [{ ...context.idsPayload, ...(first === undefined ? {} : { value: first }) }];
  return [first];
}

function invokeByPath(path: string[], args: unknown[], context: InvocationContext, ctx: ProxyContext): unknown {
  const name = ctx.toCommandName(path);
  const creator = readProperty(ctx.builder.commandCreators, name);
  if (!Object.hasOwn(ctx.builder.commandCreators, name) || typeof creator !== 'function') throw new Error(`Command ${name} not found on commandCreators.`);
  const definition = readProperty(readProperty(readProperty(ctx.builder, 'pure'), 'commandProcessors'), name);
  const command: unknown = invoke(creator, ctx.builder.commandCreators, commandArguments(definition, args, context));
  if (!command || typeof command !== 'object' || typeof readProperty(command, 'type') !== 'string' || !('payload' in command)) {
    throw new TypeError('Command creator returned an invalid envelope');
  }
  if (context.entityPk && command.payload && typeof command.payload === 'object') {
    command.payload = { ...command.payload, __entityPk: context.entityPk };
  }
  // Creator output was checked above; payload remains unknown until the domain validates it.
  const result = ctx.core.dispatch(command as Command<unknown, string>);
  if (!context.resolveState) return result;
  const state = () => readonlyValue(context.resolveState!());
  return result instanceof Promise ? result.then(state) : state();
}

function makeDeepProxy(statePath: string[], commandPath: string[], context: InvocationContext, ctx: ProxyContext): unknown {
  const name = ctx.toCommandName(commandPath);
  if (commandPath.length && Object.hasOwn(ctx.builder.commandCreators, name) && typeof readProperty(ctx.builder.commandCreators, name) === 'function') {
    return (...args: unknown[]) => ctx.invokeByPath(commandPath, args, context);
  }
  return new Proxy({}, {
    ...readonlyTraps,
    get(_target, property) {
      if (property === MirageCoreSymbol && !commandPath.length) {
        return Object.freeze({ get version() { return ctx.core.version; },
          getPendingResults: () => structuredClone(ctx.core.getPendingResults()) });
      }
      const protocol = readonlyObjectMember(property);
      if (protocol) return protocol;
      if (property === 'then' || typeof property !== 'string') return undefined;
      if (!statePath.length && Object.hasOwn(ctx.selectors, property)) return (...args: unknown[]) => ctx.invokeSelector(property, args, context);
      const target = ctx.resolvePath(statePath);
      if (target && typeof target === 'object' && Object.hasOwn(target, property)) {
        const value = readProperty(target, property);
        const mount = !statePath.length ? ctx.mounts[property] : undefined;
        if (mount?.kind === 'list') return ctx.makeCollectionProxy([...statePath, property], [mount.commandPrefix], mount, context);
        if (mount?.kind === 'map') return ctx.makeMapProxy([...statePath, property], [mount.commandPrefix], mount, context);
        return readonlyValue(value);
      }
      const path = [...commandPath, property];
      return Object.hasOwn(ctx.builder.commandCreators, ctx.toCommandName(path)) && typeof readProperty(ctx.builder.commandCreators, ctx.toCommandName(path)) === 'function'
        ? (...args: unknown[]) => ctx.invokeByPath(path, args, context) : undefined;
    }
  });
}
