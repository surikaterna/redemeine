import type {
  ProjectionCommitDefinition,
  ProjectionEvent,
  ProjectionHandler,
  ProjectionSourceCommitSnapshotLink,
  ProjectionSourceEvent
} from '@redemeine/projection-runtime-core';

export interface RoutingLinkState extends ProjectionSourceCommitSnapshotLink {}

export interface RoutedEvent<TState> {
  event: ProjectionEvent;
  handler: ProjectionHandler<TState>;
  targetIds: readonly string[];
}

export function sourceEventToProjectionEvent(event: ProjectionSourceEvent): ProjectionEvent {
  return {
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    type: event.type,
    payload: event.payload,
    sequence: event.streamVersion,
    timestamp: event.timestamp,
    ...(event.metadata ? { metadata: event.metadata } : {})
  };
}

function handlerCandidates(type: string, aggregateType: string): readonly string[] {
  const keys = new Set([type]);
  const prefix = `${aggregateType}.`;
  if (type.startsWith(prefix)) keys.add(type.slice(prefix.length).replace(/\.event$/, ''));
  if (type.endsWith('.event')) keys.add(type.slice(0, -'.event'.length));
  return [...keys];
}

function findHandler<TState>(
  definition: ProjectionCommitDefinition<TState>,
  event: ProjectionEvent
): ProjectionHandler<TState> | null {
  const streams = [definition.fromStream, ...(definition.joinStreams ?? []), ...(definition.reverseSubscribeStreams ?? [])];
  const stream = streams.find((candidate) => candidate.aggregate.aggregateType === event.aggregateType);
  if (!stream) return null;
  for (const key of handlerCandidates(event.type, event.aggregateType)) {
    const handler = stream.handlers[key];
    if (handler) return handler;
  }
  return null;
}

export function routeEvent<TState>(
  definition: ProjectionCommitDefinition<TState>,
  sourceEvent: ProjectionSourceEvent,
  links: ReadonlyMap<string, RoutingLinkState>
): RoutedEvent<TState> | null {
  const event = sourceEventToProjectionEvent(sourceEvent);
  const handler = findHandler(definition, event);
  if (!handler) return null;
  let targetIds: readonly string[] = [];
  if (event.aggregateType === definition.fromStream.aggregate.aggregateType) {
    const identity = definition.identity(event);
    targetIds = Array.isArray(identity) ? identity : [identity];
  } else {
    const targetId = links.get(`${event.aggregateType}\u0000${event.aggregateId}`)?.targetDocumentId;
    targetIds = targetId ? [targetId] : [];
  }
  return { event, handler, targetIds: [...new Set(targetIds)].sort() };
}

export function routingLinkRequests<TState>(
  definition: ProjectionCommitDefinition<TState>,
  events: readonly ProjectionSourceEvent[]
): readonly { aggregateType: string; aggregateId: string }[] {
  const fromType = definition.fromStream.aggregate.aggregateType;
  const keys = new Map<string, { aggregateType: string; aggregateId: string }>();
  for (const event of events) {
    if (event.aggregateType === fromType) continue;
    const key = `${event.aggregateType}\u0000${event.aggregateId}`;
    keys.set(key, { aggregateType: event.aggregateType, aggregateId: event.aggregateId });
  }
  return [...keys.values()];
}

export function linksByKey(links: readonly RoutingLinkState[]): Map<string, RoutingLinkState> {
  return new Map(links.map((link) => [`${link.aggregateType}\u0000${link.aggregateId}`, link]));
}
