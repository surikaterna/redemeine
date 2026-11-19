import type {
  ProjectionCandidateSelector,
  ProjectionEvent,
  ProjectionHandler,
  ProjectionSourceCommitSnapshotLink,
  ProjectionSourceEvent
} from '@redemeine/projection-runtime-core';
import { JoinTurnBudget, joinMembershipKey, selectJoinCandidates } from '@redemeine/projection-runtime-core';
import type { ProjectionCommitDefinitionInput } from './commitCoordinatorContracts';

export interface RoutingLinkState extends ProjectionSourceCommitSnapshotLink {}

export interface RoutedEvent<TState> {
  event: ProjectionEvent;
  handler: ProjectionHandler<TState>;
  targetIds: readonly string[];
  savedMembers?: ReadonlySet<string>;
}

export interface SetRoutingEntry<TState> {
  readonly event: ProjectionEvent;
  readonly handler: ProjectionHandler<TState>;
  readonly initialTargets: readonly string[];
  /** Absent for direct events; otherwise reads the membership staged at event start. */
  readonly membershipKey?: string;
}

export function planSetRouting<TState>(definition: ProjectionCommitDefinitionInput<TState>, events: readonly ProjectionSourceEvent[]):
  readonly (SetRoutingEntry<TState> | null)[] {
  const budget = new JoinTurnBudget();
  return events.map((source) => {
    const event = sourceEventToProjectionEvent(source);
    const match = findHandler(definition, event);
    if (!match) return null;
    const joined = event.aggregateType !== definition.fromStream.aggregate.aggregateType;
    const initialTargets = joined ? selectJoinCandidates(event, match.selector) : identityTargets(definition, event);
    for (const id of initialTargets) budget.add(id);
    return { event, handler: match.handler, initialTargets,
      ...(joined ? { membershipKey: joinMembershipKey(event.aggregateType, event.aggregateId) } : {}) };
  });
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
  definition: ProjectionCommitDefinitionInput<TState>,
  event: ProjectionEvent
): { handler: ProjectionHandler<TState>; selector?: ProjectionCandidateSelector | undefined } | null {
  const streams: readonly {
    aggregate: { aggregateType: string };
    handlers: Record<string, ProjectionHandler<TState>>;
    candidateSelectors?: Readonly<Record<string, ProjectionCandidateSelector>>;
  }[] = [definition.fromStream, ...(definition.joinStreams ?? []), ...(definition.reverseSubscribeStreams ?? [])];
  const stream = streams.find((candidate) => candidate.aggregate.aggregateType === event.aggregateType);
  if (!stream) return null;
  for (const key of handlerCandidates(event.type, event.aggregateType)) {
    const handler = Object.hasOwn(stream.handlers, key) ? stream.handlers[key] : undefined;
    if (handler) return { handler, ...(stream.candidateSelectors && Object.hasOwn(stream.candidateSelectors, key)
      ? { selector: stream.candidateSelectors[key] } : {}) };
  }
  return null;
}

export function routeEvent<TState>(
  definition: ProjectionCommitDefinitionInput<TState>,
  sourceEvent: ProjectionSourceEvent,
  links: ReadonlyMap<string, RoutingLinkState>
): RoutedEvent<TState> | null {
  const event = sourceEventToProjectionEvent(sourceEvent);
  const match = findHandler(definition, event);
  if (!match) return null;
  const { handler } = match;
  let targetIds: readonly string[] = [];
  if (event.aggregateType === definition.fromStream.aggregate.aggregateType) {
    targetIds = identityTargets(definition, event);
  } else {
    const targetId = links.get(`${event.aggregateType}\u0000${event.aggregateId}`)?.targetDocumentId;
    targetIds = targetId ? [targetId] : [];
  }
  return { event, handler, targetIds: [...new Set(targetIds)].sort() };
}

function identityTargets<TState>(definition: ProjectionCommitDefinitionInput<TState>, event: ProjectionEvent): readonly string[] {
  const identity = definition.identity(event);
  return typeof identity === 'string' ? [identity] : identity;
}

export function routingLinkRequests<TState>(
  definition: ProjectionCommitDefinitionInput<TState>,
  events: readonly ProjectionSourceEvent[]
): readonly { aggregateType: string; aggregateId: string }[] {
  const fromType = definition.fromStream.aggregate.aggregateType;
  const keys = new Map<string, { aggregateType: string; aggregateId: string }>();
  for (const event of events) {
    if (event.aggregateType === fromType || !findHandler(definition, sourceEventToProjectionEvent(event))) continue;
    const key = definition.joinMembership ? joinMembershipKey(event.aggregateType, event.aggregateId)
      : `${event.aggregateType}\u0000${event.aggregateId}`;
    keys.set(key, { aggregateType: event.aggregateType, aggregateId: event.aggregateId });
  }
  return [...keys.values()];
}

export function linksByKey(links: readonly RoutingLinkState[]): Map<string, RoutingLinkState> {
  return new Map(links.map((link) => [`${link.aggregateType}\u0000${link.aggregateId}`, link]));
}
