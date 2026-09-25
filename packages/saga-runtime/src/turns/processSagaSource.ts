import type { CompiledSagaRoutingTable } from '../routing/contracts';
import type { SagaTurnProcessorOptions, SagaTurnRepository, SagaTurnRouteOutcome, SagaTurnSourceEvent } from './contracts';
import { processSagaTurn } from './processSagaTurn';
import { matchSagaTurnRouteGroups, resolveSagaTurnRouteGroup } from './routePlanning';
import { normalizeSagaTurnSourceEvent } from './sourceValidation';
import { createSagaTurnAggregateEvent } from './aggregateEvent';

export async function processSagaSourceEvent(
  table: CompiledSagaRoutingTable,
  repository: SagaTurnRepository,
  sourceEvent: SagaTurnSourceEvent,
  options: SagaTurnProcessorOptions
): Promise<readonly SagaTurnRouteOutcome[]> {
  const source = normalizeSagaTurnSourceEvent(sourceEvent);
  const event = createSagaTurnAggregateEvent(source);
  const groups = matchSagaTurnRouteGroups(table, source, event);
  const resolved = groups.map((group) => resolveSagaTurnRouteGroup(group, source, event));
  const outcomes: SagaTurnRouteOutcome[] = [];
  for (const routeGroup of resolved) {
    outcomes.push(await processSagaTurn(repository, routeGroup, source, options));
  }
  return outcomes;
}

export async function processSagaSourceEvents(
  table: CompiledSagaRoutingTable,
  repository: SagaTurnRepository,
  sourceEvents: readonly SagaTurnSourceEvent[],
  options: SagaTurnProcessorOptions
): Promise<readonly SagaTurnRouteOutcome[]> {
  const outcomes: SagaTurnRouteOutcome[] = [];
  for (const source of sourceEvents) {
    outcomes.push(...await processSagaSourceEvent(table, repository, source, options));
  }
  return outcomes;
}
