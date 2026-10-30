import type { NamingStrategy } from '@redemeine/kernel';
import type { GenericCommandMap } from '../redemeineComponent';
import { attachPackReceiver, resolveCommandHandler } from '../redemeineComponent';
import type { CommandMetadata } from '../commandMetadata';
import { resolvedCommandTargets } from './entityCommandTarget';
import { commandModes } from '../entityCommandLifecycle';
import { mountedWire } from './mountedNaming';

function snapshotDefinition(definition: GenericCommandMap[string]): GenericCommandMap[string] {
  if (typeof definition === 'function') return definition;
  const pack = 'pack' in definition ? definition.pack : undefined;
  const owned = { handler: definition.handler,
    ...('pack' in definition ? { pack } : {}),
    ...('meta' in definition ? { meta: definition.meta } : {}) };
  const properties = Object.getOwnPropertyDescriptors(definition);
  for (const key of ['handler', 'pack', 'meta']) delete properties[key];
  Object.setPrototypeOf(owned, Object.getPrototypeOf(definition));
  Object.defineProperties(owned, properties);
  attachPackReceiver(owned, definition);
  return Object.freeze(owned);
}

/** Capture registration fields without freezing caller-owned functions or descriptors. */
export function compileCommands(definitions: GenericCommandMap, overrides: Record<string, string>, aggregateName: string, naming: NamingStrategy) {
  const snapshot: GenericCommandMap = Object.create(null);
  const handlers: Record<string, ReturnType<typeof resolveCommandHandler>> = Object.create(null);
  const types: Record<string, string> = Object.create(null);
  const metadata: Record<string, { meta?: Record<string, unknown> }> = Object.create(null);
  const targets = resolvedCommandTargets(definitions);
  const targetsByType: Record<string, typeof targets[string]> = Object.create(null);
  const winners = new Map<string, string>();
  const staticByType: Record<string, boolean> = Object.create(null);
  for (const [localName, definition] of Object.entries(definitions)) {
    const owned = snapshotDefinition(definition);
    const wireType = (Object.hasOwn(overrides, localName) && overrides[localName])
      || mountedWire(definitions, localName, aggregateName, naming, 'command') || naming.command(aggregateName, localName);
    snapshot[localName] = owned;
    handlers[wireType] = resolveCommandHandler(owned);
    targetsByType[wireType] = targets[localName]!;
    staticByType[wireType] = commandModes(definitions)[localName] ?? false;
    types[localName] = wireType;
    const meta = 'meta' in owned ? owned.meta : undefined;
    metadata[wireType] = meta !== undefined ? { meta } : {};
    winners.set(wireType, localName);
  }
  const records = new Map<string, CommandMetadata>();
  for (const [localName, wireType] of Object.entries(types)) {
    const winnerLocalName = winners.get(wireType)!;
    records.set(localName, Object.freeze({ localName, wireType, winnerLocalName,
      isWireWinner: winnerLocalName === localName, isStatic: commandModes(definitions)[localName] ?? false,
      targets: Object.freeze(targets[localName]!.map(({ initialState: _initialState, ...target }) => Object.freeze(target))) }));
  }
  return { snapshot: Object.freeze(snapshot), handlers, types: Object.freeze(types), metadata, targets, targetsByType, staticByType, records };
}
