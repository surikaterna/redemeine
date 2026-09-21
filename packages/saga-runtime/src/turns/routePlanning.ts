import { deriveSagaInstanceId, deriveSourceTriggerId } from '../identity/deterministicIds';
import { assertMatchingSagaCorrelations, normalizeSagaCorrelation } from '../identity/index';
import { matchSagaRoutes } from '../routing/compileSagaRoutes';
import type { CompiledSagaRoute, CompiledSagaRoutingTable } from '../routing/contracts';
import type { ResolvedSagaTurnRouteGroup, SagaTurnRouteGroup, SagaTurnSourceEvent } from './contracts';
import type { SagaTurnAggregateEvent } from './aggregateEvent';
import { SagaTurnError, SagaTurnPermanentError } from './errors';

function groupRoutes(routes: readonly CompiledSagaRoute[]): readonly SagaTurnRouteGroup[] {
  const grouped = new Map<string, CompiledSagaRoute[]>();
  for (const route of routes) {
    const existing = grouped.get(route.sagaKey) ?? [];
    existing.push(route);
    grouped.set(route.sagaKey, existing);
  }
  return Array.from(grouped, ([sagaKey, groupedRoutes]) => ({ sagaKey, routes: groupedRoutes }));
}

function isApplicable(route: CompiledSagaRoute, event: SagaTurnAggregateEvent): boolean {
  if (route.kind === 'on' || route.when === undefined) return true;
  try {
    return route.when(event);
  } catch (error) {
    throw new SagaTurnPermanentError('route_resolution_failed', `Start predicate failed for ${route.sagaKey}`, { sagaKey: route.sagaKey }, error);
  }
}

export function matchSagaTurnRouteGroups(
  table: CompiledSagaRoutingTable,
  source: SagaTurnSourceEvent,
  event: SagaTurnAggregateEvent
): readonly SagaTurnRouteGroup[] {
  const routes = matchSagaRoutes(table, source)
    .map(({ route }) => route)
    .filter((route) => isApplicable(route, event));
  return groupRoutes(routes);
}

function singleRoute<TKind extends CompiledSagaRoute['kind']>(routes: readonly CompiledSagaRoute[], kind: TKind): Extract<CompiledSagaRoute, { kind: TKind }> | null {
  const matches = routes.filter((route): route is Extract<CompiledSagaRoute, { kind: TKind }> => route.kind === kind);
  if (matches.length > 1) throw new SagaTurnPermanentError('ambiguous_route', `Multiple ${kind} routes matched one saga definition`);
  return matches[0] ?? null;
}

function resolveStartCorrelation(route: Extract<CompiledSagaRoute, { kind: 'start' }>, event: SagaTurnAggregateEvent) {
  return normalizeSagaCorrelation(route.correlate(route.toStartInput(event)));
}

function resolveOnCorrelation(route: Extract<CompiledSagaRoute, { kind: 'on' }>, event: SagaTurnAggregateEvent) {
  return normalizeSagaCorrelation(route.correlate(event));
}

export function resolveSagaTurnRouteGroup(
  group: SagaTurnRouteGroup,
  source: SagaTurnSourceEvent,
  event: SagaTurnAggregateEvent
): ResolvedSagaTurnRouteGroup {
  try {
    const startRoute = singleRoute(group.routes, 'start');
    const onRoute = singleRoute(group.routes, 'on');
    if (!startRoute && !onRoute) throw new SagaTurnPermanentError('missing_route', 'Matched route group is empty');
    const startCorrelation = startRoute ? resolveStartCorrelation(startRoute, event) : null;
    const onCorrelation = onRoute ? resolveOnCorrelation(onRoute, event) : null;
    const correlation = startCorrelation && onCorrelation
      ? assertMatchingSagaCorrelations(startCorrelation, onCorrelation)
      : startCorrelation ?? onCorrelation;
    if (!correlation) throw new SagaTurnPermanentError('missing_correlation', 'Matched route has no correlation');
    return {
      sagaKey: group.sagaKey,
      sourceTriggerId: deriveSourceTriggerId(source),
      instanceId: deriveSagaInstanceId(group.sagaKey, correlation),
      correlation,
      event,
      startRoute,
      onRoute
    };
  } catch (error) {
    if (error instanceof SagaTurnError) throw error;
    throw new SagaTurnPermanentError('route_resolution_failed', `Failed to resolve route for ${group.sagaKey}`, { sagaKey: group.sagaKey }, error);
  }
}
