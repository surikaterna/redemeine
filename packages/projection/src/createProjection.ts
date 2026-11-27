import type { ProjectionDeduplicationStrategy } from './deduplication';
import { defaultIdentity, isInheritEntry, isInheritExtended } from './inherit';
import { mirrorEventHandlers } from './mirrorEventHandlers';
import type {
  AggregateStateOf,
  InheritableHandlersForAggregate,
  JoinStreamDefinition,
  MirrorableAggregateConstraint,
  MirrorableAggregateSource,
  ProjectionAggregateSource,
  ProjectionBuilder,
  ProjectionCandidateSelector,
  ProjectionCandidateSelectors,
  ProjectionCommitBuilder,
  ProjectionCommitDefinition,
  ProjectionContext,
  ProjectionDefinition,
  ProjectionHandler,
  ProjectionHandlersForAggregate,
  ProjectionHooks,
  ProjectionStreamDefinition
} from './projectionTypes';
import { resolveEventHandlers } from './resolvedEventHandlers';
import type { ProjectionEvent as BaseProjectionEvent } from './types';

export type { InheritExtended, InheritToken } from './inherit';
export { inherit } from './inherit';
export type {
  AggregateDefinition,
  AggregateEventKeys,
  AggregateEventPayloadByKey,
  AggregateEventPayloadMap,
  AggregateStateOf,
  JoinStreamDefinition,
  MirrorableAggregateSource,
  ProjectionBuilder,
  ProjectionCommitBuilder,
  ProjectionCommitDefinition,
  ProjectionContext,
  ProjectionCandidateSelector,
  ProjectionCandidateSelectors,
  ProjectionDefinition,
  ProjectionHandler,
  ProjectionHandlers,
  ProjectionHooks,
  ProjectionStreamDefinition
} from './projectionTypes';

class ProjectionBuilderImpl<TState> implements ProjectionBuilder<TState> {
  private _initialState: ((id: string) => TState) | undefined;
  private _identity: (event: BaseProjectionEvent) => string | readonly string[] = defaultIdentity;
  private _fromStream: ProjectionStreamDefinition<TState> | null = null;
  private _joinStreams: JoinStreamDefinition<TState>[] = [];
  private _joinRight = new Map<string, Readonly<Record<string, ProjectionCandidateSelector>>>();
  private _hooks: ProjectionHooks<TState> = {};
  private _deduplication: ProjectionDeduplicationStrategy | undefined;

  constructor(
    private _name: string,
    initialState?: (id: string) => TState
  ) {
    this._initialState = initialState;
  }

  initialState(fn: (id: string) => TState): ProjectionBuilder<TState> {
    this._initialState = fn;
    return this;
  }

  identity(fn: (event: BaseProjectionEvent) => string | readonly string[]): ProjectionBuilder<TState> {
    this._identity = fn;
    return this;
  }

  private _resolveHandlers<THandlerState>(
    aggregate: ProjectionAggregateSource,
    handlers: Record<string, unknown>
  ): Record<string, ProjectionHandler<THandlerState>> {
    const resolved: Record<string, ProjectionHandler<THandlerState>> = {};

    for (const [key, value] of Object.entries(handlers)) {
      if (!value) continue;
      if (isInheritExtended(value)) {
        this._assertMirrorable(aggregate);
        const after = value.after;
        resolved[key] = (draft, event, context) => {
          aggregate.applyToDraft(draft, event);
          after(draft, event, context);
        };
      } else if (isInheritEntry(value)) {
        this._assertMirrorable(aggregate);
        resolved[key] = (draft, event) => aggregate.applyToDraft(draft, event);
      } else {
        resolved[key] = value as ProjectionHandler<THandlerState>;
      }
    }
    return resolveEventHandlers(aggregate, resolved);
  }

  private _assertMirrorable<THandlerState>(
    aggregate: ProjectionAggregateSource
  ): asserts aggregate is MirrorableAggregateSource<THandlerState, BaseProjectionEvent> {
    if (!('applyToDraft' in aggregate) || typeof aggregate.applyToDraft !== 'function') {
      throw new Error(`Projection '${this._name}': inherit requires an aggregate with applyToDraft.`);
    }
  }

  private _inheritedHandler<THandlerState>(aggregate: ProjectionAggregateSource): ProjectionHandler<THandlerState> {
    this._assertMirrorable(aggregate);
    return (draft, event) => aggregate.applyToDraft(draft, event);
  }

  from<TAggregate extends ProjectionAggregateSource>(
    aggregate: TAggregate,
    handlers: InheritableHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState> {
    this._fromStream = { aggregate, handlers: this._resolveHandlers<TState>(aggregate, handlers) };
    return this;
  }

  mirror<TAggregate extends MirrorableAggregateConstraint>(
    aggregate: TAggregate,
    handlers?: InheritableHandlersForAggregate<AggregateStateOf<TAggregate>, TAggregate>
  ): ProjectionBuilder<AggregateStateOf<TAggregate>> {
    const explicit: Record<string, unknown> = handlers ? { ...handlers } : {};
    const builder = this as ProjectionBuilderImpl<AggregateStateOf<TAggregate>>;
    builder._fromStream = {
      aggregate,
      handlers: mirrorEventHandlers(
        aggregate,
        explicit,
        this._resolveHandlers<AggregateStateOf<TAggregate>>(aggregate, explicit),
        this._inheritedHandler<AggregateStateOf<TAggregate>>(aggregate)
      )
    };
    if (!builder._initialState) {
      builder._initialState = () => structuredClone(aggregate.initialState) as AggregateStateOf<TAggregate>;
    }
    return builder;
  }

  join<TAggregate extends { aggregateType: string }>(
    aggregate: TAggregate,
    handlers: ProjectionHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState> {
    const handlersMap: Record<string, ProjectionHandler<TState>> = {};
    for (const [key, handler] of Object.entries(handlers)) {
      if (handler) handlersMap[key] = handler as ProjectionHandler<TState>;
    }
    this._joinStreams.push({ aggregate, handlers: resolveEventHandlers(aggregate, handlersMap) });
    return this;
  }

  hooks(hooks: ProjectionHooks<TState>): ProjectionBuilder<TState> {
    this._hooks = { ...this._hooks, ...hooks };
    return this;
  }

  joinRight<TAggregate extends { aggregateType: string }>(
    aggregate: TAggregate,
    selectors: ProjectionCandidateSelectors<NoInfer<TAggregate>>
  ): ProjectionBuilder<TState> {
    if (this._joinRight.has(aggregate.aggregateType)) throw new Error('Duplicate .joinRight() aggregate.');
    this._joinRight.set(aggregate.aggregateType,
      Object.freeze(resolveEventHandlers(aggregate, { ...selectors } as unknown as Record<string, ProjectionCandidateSelector>)));
    return this;
  }

  private _buildJoins(): JoinStreamDefinition<TState>[] {
    for (const [type, selectors] of this._joinRight) {
      const joins = this._joinStreams.filter(({ aggregate }) => aggregate.aggregateType === type);
      if (type === this._fromStream?.aggregate.aggregateType || joins.length !== 1
        || Object.entries(selectors).some(([key, selector]) => typeof selector !== 'function' || !Object.hasOwn(joins[0]!.handlers, key))) {
        throw new Error(`Projection '${this._name}': .joinRight(${type}) requires one .join() with matching handlers.`);
      }
    }
    if (!this._joinRight.size) return this._joinStreams;
    return this._joinStreams.map((stream) => {
      const candidateSelectors = this._joinRight.get(stream.aggregate.aggregateType);
      return candidateSelectors ? { ...stream, candidateSelectors } : stream;
    });
  }

  deduplication(strategy: ProjectionDeduplicationStrategy): ProjectionCommitBuilder<TState> {
    if (strategy.strategy === 'none' && strategy.reason.trim().length === 0) {
      throw new Error(`Projection '${this._name}': none deduplication requires a reason.`);
    }
    this._deduplication = strategy;
    // Fluent methods retain this builder and never clear the configured strategy.
    return this as unknown as ProjectionCommitBuilder<TState>;
  }

  buildCommitDefinition(): ProjectionCommitDefinition<TState> {
    const definition = this.build();
    if (!definition.deduplication) {
      throw new Error(`Projection '${this._name}' requires an explicit deduplication strategy.`);
    }
    return definition as ProjectionCommitDefinition<TState>;
  }

  build(): ProjectionDefinition<TState> {
    if (!this._fromStream) {
      throw new Error(`Projection '${this._name}' must have at least one .from() stream`);
    }
    if (!this._initialState) {
      throw new Error(`Projection '${this._name}' requires an initial state. ` + `Use .mirror() or createProjection(name, fn) to provide one.`);
    }
    return {
      name: this._name,
      fromStream: this._fromStream,
      joinStreams: this._buildJoins(),
      ...(this._joinRight.size ? { joinMembership: 'set-v1' } : {}),
      initialState: this._initialState,
      identity: this._identity,
      subscriptions: [],
      hooks: this._hooks,
      ...(this._deduplication ? { deduplication: this._deduplication } : {})
    };
  }
}

export function createProjection<TState>(name: string, initialState: (id: string) => TState): ProjectionBuilder<TState>;
export function createProjection(name: string): ProjectionBuilder<unknown>;
export function createProjection<TState = unknown>(name: string, initialState?: (id: string) => TState): ProjectionBuilder<TState> {
  return new ProjectionBuilderImpl(name, initialState);
}
