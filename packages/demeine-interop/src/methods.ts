import type { Event } from '@redemeine/kernel';
import { requireLegacyPayload } from './dispatch';
import type { BridgeableAggregate, BridgeCommand, BridgeContext, CommandCreators } from './types';

function dispatchName(type: string, command: boolean): string {
  const parts = type.split('.').slice(1, -1);
  if (command && parts.length) parts.unshift(parts.pop()!);
  const key = parts.join('_').replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (!key) throw new Error(`Cannot derive legacy method from ${type}`);
  return `${command ? 'process' : 'apply'}${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

export function installMethods<S extends object, C extends CommandCreators>(
  prototype: object, builder: BridgeableAggregate<S, C>,
  dispatch: { process(aggregate: BridgeContext<S>, command: BridgeCommand): unknown; apply(aggregate: BridgeContext<S>, event: Event): void },
): void {
  // The base resolves commands to this instance; a `then` shortcut would cause
  // promise assimilation to enqueue a command behind its own pending command.
  const reserved = new Set(['then', 'id', 'type', '_state', '_version', '_uncommittedEvents', '_commandSink', '_commandHandler', '_eventHandler', '_commandQueue']);
  const define = (name: string, value: unknown) => {
    if (name in prototype || reserved.has(name)) throw new Error(`Legacy method collision: ${name}`);
    Object.defineProperty(prototype, name, { value, writable: true, configurable: true });
  };
  for (const type of Object.values(builder.types.commands)) {
    define(dispatchName(type, true), function (this: BridgeContext<S>, command: BridgeCommand) { return dispatch.process(this, command); });
  }
  for (const type of Object.values(builder.types.events)) {
    define(dispatchName(type, false), function (this: BridgeContext<S>, event: Event) { return dispatch.apply(this, event); });
  }
  for (const key of Object.keys(builder.types.commands)) {
    const creator = builder.commandCreators[key];
    if (typeof creator !== 'function') throw new Error(`Missing command creator: ${key}`);
    define(key, function (this: BridgeContext<S>, ...args: unknown[]) {
      const command: BridgeCommand = Reflect.apply(creator, builder.commandCreators, args);
      return this._sink(requireLegacyPayload({ ...command, aggregateId: command.aggregateId ?? this.id }));
    });
  }
}
