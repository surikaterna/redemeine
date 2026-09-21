import { deriveSagaInstanceId, deriveSourceTriggerId } from '../identity/deterministicIds';
import { assertMatchingSagaCorrelations, normalizeSagaCorrelation } from '../identity/index';
import { matchSagaRoutes } from '../routing/compileSagaRoutes';
import type { CompiledSagaRoute, CompiledSagaRoutingTable } from '../routing/contracts';
import type { ResolvedSagaTurnRouteGroup, SagaTurnRouteGroup, SagaTurnSourceEvent } from './contracts';
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

export function matchSagaTurnRouteGroups(table: CompiledSagaRoutingTable, source: SagaTurnSourceEvent): readonly SagaTurnRouteGroup[] {
  return groupRoutes(matchSagaRoutes(table, source).map(({ route }) => route));
}

function singleRoute<TKind extends CompiledSagaRoute['kind']>(routes: readonly CompiledSagaRoute[], kind: TKind): Extract<CompiledSagaRoute, { kind: TKind }> | null {
  const matches = routes.filter((route): route is Extract<CompiledSagaRoute, { kind: TKind }> => route.kind === kind);
  if (matches.length > 1) throw new SagaTurnPermanentError('ambiguous_route', `Multiple ${kind} routes matched one saga definition`);
  return matches[0] ?? null;
}

function resolveStartCorrelation(route: Extract<CompiledSagaRoute, { kind: 'start' }>, source: SagaTurnSourceEvent) {
  return normalizeSagaCorrelation(route.correlate(route.toStartInput(source)));
}

function resolveOnCorrelation(route: Extract<CompiledSagaRoute, { kind: 'on' }>, source: SagaTurnSourceEvent) {
  return normalizeSagaCorrelation(route.correlate(source));
}

export function resolveSagaTurnRouteGroup(group: SagaTurnRouteGroup, source: SagaTurnSourceEvent): ResolvedSagaTurnRouteGroup {
  try {
    const startRoute = singleRoute(group.routes, 'start');
    const onRoute = singleRoute(group.routes, 'on');
    if (!startRoute && !onRoute) throw new SagaTurnPermanentError('missing_route', 'Matched route group is empty');
    const startCorrelation = startRoute ? resolveStartCorrelation(startRoute, source) : null;
    const onCorrelation = onRoute ? resolveOnCorrelation(onRoute, source) : null;
    const correlation = startCorrelation && onCorrelation
      ? assertMatchingSagaCorrelations(startCorrelation, onCorrelation)
      : startCorrelation ?? onCorrelation;
    if (!correlation) throw new SagaTurnPermanentError('missing_correlation', 'Matched route has no correlation');
    return {
      sagaKey: group.sagaKey,
      sourceTriggerId: deriveSourceTriggerId(source),
      instanceId: deriveSagaInstanceId(group.sagaKey, correlation),
      correlation,
      startRoute,
      onRoute
    };
  } catch (error) {
    if (error instanceof SagaTurnError) throw error;
    throw new SagaTurnPermanentError('route_resolution_failed', `Failed to resolve route for ${group.sagaKey}`, { sagaKey: group.sagaKey }, error);
  }
}
