import type { Event } from '@redemeine/kernel';
import { preserveValue, requireSync } from './guards';
import { normalizeEnvelope } from './normalizeEnvelope';
import { preservePreparedValue } from './preparedValue';
import type { BridgeableAggregate, BridgeCommand, BridgeContext, BridgeEvent, BridgeOptions, CommandCreators } from './types';

function preparedFields(event: object, keys: PropertyKey[]): object {
  const fields = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(event, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) throw new TypeError('Envelope must preserve prepared data properties');
    Object.defineProperty(fields, key, { value: descriptor.value, enumerable: true, configurable: true });
  }
  return fields;
}

function convertEvent<S extends object>(
  event: Event, command: BridgeCommand, aggregate: BridgeContext<S>, envelope: BridgeOptions<S>['envelope'], preservePrepared: boolean,
): BridgeEvent {
  if (!command.id) throw new Error('Builder events require a command id');
  const addressed = { ...event, aggregateId: aggregate.id, correlationId: command.id };
  const { id, type, aggregateId, correlationId } = addressed;
  const metadataMatches = preserveValue(addressed.metadata);
  const preparedKeys = Reflect.ownKeys(addressed).filter(key => key !== 'payload' && key !== 'metadata');
  const preparedMatches = preservePrepared
    ? preservePreparedValue(preparedFields(addressed, preparedKeys)) : undefined;
  const converted = requireSync(envelope ? envelope(addressed, command, aggregate) : addressed, 'envelope');
  if (!converted || !converted.type || converted.type !== type || converted.id !== id
    || converted.aggregateId !== aggregateId || converted.correlationId !== correlationId
    || !metadataMatches(converted.metadata) || (preparedMatches && !preparedMatches(preparedFields(converted, preparedKeys)))
    || !converted.payload || typeof converted.payload !== 'object') {
    throw new Error('Envelope must preserve event identity, addressing and metadata with an object payload');
  }
  return converted;
}

export function createDispatch<S extends object, C extends CommandCreators>(
  builder: BridgeableAggregate<S, C>, options: BridgeOptions<S>,
) {
  const commandTypes = new Set(Object.values(builder.types.commands));
  const activeEnvelopes = !!builder.aggregatePlugins?.some(plugin => plugin.commandEnvelope || plugin.eventEnvelope);
  if (activeEnvelopes && !builder.prepareCommand) throw new TypeError('Envelope plugins require builder.prepareCommand');
  function normalize<T extends BridgeCommand>(command: T): T {
    if (!activeEnvelopes) return command;
    const type = Object.getOwnPropertyDescriptor(command, 'type');
    if (type && 'value' in type && type.value === '$stream.delete.command') return command;
    return normalizeEnvelope(command);
  }
  function prepare(aggregate: BridgeContext<S>, command: BridgeCommand): BridgeCommand {
    command = normalize(command);
    if (!activeEnvelopes || !builder.prepareCommand || command.type === '$stream.delete.command') return command;
    command.aggregateId ??= aggregate.id;
    if (command.aggregateId !== aggregate.id) throw new Error('command aggregateId does not match aggregate');
    if (aggregate.type) command.aggregateType = aggregate.type;
    const prepared = requireSync(builder.prepareCommand(aggregate._state, command), 'builder.prepareCommand');
    // Legacy services own these transport fields, not aggregate envelope plugins.
    for (const key of ['status', 'refs']) {
      if (Object.hasOwn(command, key) && !Object.hasOwn(prepared, key)) Reflect.set(prepared, key, Reflect.get(command, key));
    }
    return prepared;
  }
  function process(aggregate: BridgeContext<S>, command: BridgeCommand): BridgeContext<S> {
    command = normalize(command);
    if (command.type === '$stream.delete.command') return aggregate.processDelete(requireLegacyPayload(command));
    if (!commandTypes.has(command.type)) throw new Error(`Unknown command: ${command.type}`);
    command = prepare(aggregate, command);
    const events = requireSync(builder.process(aggregate._state, command), 'builder.process');
    if ('__intents' in events && events.__intents != null) throw new Error('demeine-interop does not support intents');
    const converted = events.map(event => convertEvent(event, command, aggregate, options.envelope, activeEnvelopes));
    for (const event of converted) aggregate._apply(requireLegacyPayload(event), true);
    return aggregate;
  }
  function apply(aggregate: BridgeContext<S>, event: Event<unknown, string>): void {
    if (event.type === '$stream.deleted.event') {
      aggregate.applyDeleted();
      return;
    }
    aggregate._state = requireSync(builder.apply(aggregate._state, event), 'builder.apply');
  }
  return { process, apply, prepare, normalize, activeEnvelopes };
}

export function requireLegacyPayload<T extends { payload: unknown }>(message: T): T & { payload: object } {
  if (!message.payload || typeof message.payload !== 'object') throw new TypeError('Legacy messages require object payloads');
  // The guard narrows payload, but TypeScript cannot express narrowing a generic intersection.
  return message as T & { payload: object };
}
