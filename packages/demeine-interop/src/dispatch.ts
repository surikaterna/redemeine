import type { Event } from '@redemeine/kernel';
import { preserveValue, requireSync } from './guards';
import type { BridgeableAggregate, BridgeCommand, BridgeContext, BridgeEvent, BridgeOptions, CommandCreators } from './types';

function convertEvent<S extends object>(
  event: Event, command: BridgeCommand, aggregate: BridgeContext<S>, envelope: BridgeOptions<S>['envelope'],
): BridgeEvent {
  if (!command.id) throw new Error('Builder events require a command id');
  const addressed = { ...event, aggregateId: aggregate.id, correlationId: command.id };
  const { id, type, aggregateId, correlationId } = addressed;
  const metadataMatches = preserveValue(addressed.metadata);
  const converted = requireSync(envelope ? envelope(addressed, command, aggregate) : addressed, 'envelope');
  if (!converted || !converted.type || converted.type !== type || converted.id !== id
    || converted.aggregateId !== aggregateId || converted.correlationId !== correlationId
    || !metadataMatches(converted.metadata) || !converted.payload || typeof converted.payload !== 'object') {
    throw new Error('Envelope must preserve event identity, addressing and metadata with an object payload');
  }
  return converted;
}

export function createDispatch<S extends object, C extends CommandCreators>(
  builder: BridgeableAggregate<S, C>, options: BridgeOptions<S>,
) {
  const commandTypes = new Set(Object.values(builder.types.commands));
  function process(aggregate: BridgeContext<S>, command: BridgeCommand): BridgeContext<S> {
    if (command.type === '$stream.delete.command') return aggregate.processDelete(requireLegacyPayload(command));
    if (!commandTypes.has(command.type)) throw new Error(`Unknown command: ${command.type}`);
    const events = requireSync(builder.process(aggregate._state, command), 'builder.process');
    if ('__intents' in events && events.__intents != null) throw new Error('demeine-interop does not support intents');
    const converted = events.map(event => convertEvent(event, command, aggregate, options.envelope));
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
  return { process, apply };
}

export function requireLegacyPayload<T extends { payload: unknown }>(message: T): T & { payload: object } {
  if (!message.payload || typeof message.payload !== 'object') throw new TypeError('Legacy messages require object payloads');
  // The guard narrows payload, but TypeScript cannot express narrowing a generic intersection.
  return message as T & { payload: object };
}
