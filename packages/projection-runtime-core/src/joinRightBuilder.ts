import type { AggregateEventKeys, AggregateEventPayloadByKey, JoinStreamDefinition } from './createProjection';
import { resolveEventHandlers, type ResolvedHandlerEventType } from './resolvedEventHandlers';
import type { ProjectionEvent } from './types';

export type ProjectionCandidateSelector<TEvent = ProjectionEvent> =
  (event: Readonly<TEvent>) => string | readonly string[] | null | undefined;

export type ProjectionCandidateSelectors<TAggregate> = {
  [K in AggregateEventKeys<TAggregate>]?: ProjectionCandidateSelector<Omit<ProjectionEvent, 'payload' | 'type'> & {
    payload: NonNullable<AggregateEventPayloadByKey<TAggregate, K>>;
    type: ResolvedHandlerEventType<TAggregate, K>;
  }>;
};

export class JoinRightBuilder<TState> {
  private readonly selectors = new Map<string, Readonly<Record<string, ProjectionCandidateSelector>>>();

  get enabled(): boolean { return this.selectors.size > 0; }

  add<TAggregate extends { aggregateType: string }>(
    aggregate: TAggregate, selectors: ProjectionCandidateSelectors<NoInfer<TAggregate>>
  ): void {
    if (this.selectors.has(aggregate.aggregateType)) throw new Error('Duplicate .joinRight() aggregate.');
    this.selectors.set(aggregate.aggregateType,
      Object.freeze(resolveEventHandlers(aggregate, { ...selectors } as unknown as Record<string, ProjectionCandidateSelector>)));
  }

  build(name: string, fromType: string, streams: JoinStreamDefinition<TState>[]): JoinStreamDefinition<TState>[] {
    if (!this.enabled) return streams;
    for (const [type, selectors] of this.selectors) {
      const joins = streams.filter(({ aggregate }) => aggregate.aggregateType === type);
      if (type === fromType || joins.length !== 1
        || Object.entries(selectors).some(([key, selector]) => typeof selector !== 'function' || !Object.hasOwn(joins[0]!.handlers, key))) {
        throw new Error(`Projection '${name}': .joinRight(${type}) requires one .join() with matching handlers.`);
      }
    }
    return streams.map((stream) => {
      const candidateSelectors = this.selectors.get(stream.aggregate.aggregateType);
      return candidateSelectors ? { ...stream, candidateSelectors } : stream;
    });
  }
}
