import type { ProjectionDeduplicationStrategy } from './deduplication';
import type { InheritExtended } from './inherit';
import { defaultIdentity, inherit, isInheritEntry, isInheritExtended } from './inherit';
import type {
  AggregateStateOf,
  InheritableHandlersForAggregate,
  JoinStreamDefinition,
  MirrorableAggregateSource,
  ProjectionAggregateSource,
  ProjectionBuilder,
  ProjectionCommitBuilder,
  ProjectionCommitDefinition,
  ProjectionContext,
  ProjectionDefinition,
  ProjectionHandler,
  ProjectionHandlersForAggregate,
  ProjectionHooks,
  ProjectionStreamDefinition
} from './projectionTypes';
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
    const applyToDraft = (aggregate as MirrorableAggregateSource).applyToDraft as (draft: THandlerState, event: BaseProjectionEvent) => void;

    for (const [key, value] of Object.entries(handlers)) {
      if (!value) continue;
      if (isInheritExtended(value)) {
        this._assertMirrorable(aggregate);
        const after = (value as InheritExtended<THandlerState, BaseProjectionEvent>).after;
        resolved[key] = (draft, event, context) => {
          applyToDraft(draft, event);
          after(draft, event, context);
        };
      } else if (isInheritEntry(value)) {
        this._assertMirrorable(aggregate);
        resolved[key] = (draft, event) => applyToDraft(draft, event);
      } else {
        resolved[key] = value as ProjectionHandler<THandlerState>;
      }
    }
    return resolved;
  }

  private _assertMirrorable(aggregate: ProjectionAggregateSource): asserts aggregate is MirrorableAggregateSource {
    if (!(aggregate as Partial<MirrorableAggregateSource>).applyToDraft) {
      throw new Error(`Projection '${this._name}': inherit requires an aggregate with applyToDraft.`);
    }
  }

  from<TAggregate extends ProjectionAggregateSource>(
    aggregate: TAggregate,
    handlers: InheritableHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState> {
    this._fromStream = { aggregate, handlers: this._resolveHandlers<TState>(aggregate, handlers) };
    return this;
  }

  mirror<TAggregate extends MirrorableAggregateSource>(
    aggregate: TAggregate,
    handlers?: InheritableHandlersForAggregate<AggregateStateOf<TAggregate>, TAggregate>
  ): ProjectionBuilder<AggregateStateOf<TAggregate>> {
    const explicit: Record<string, unknown> = handlers ? { ...handlers } : {};
    for (const key of Object.keys(aggregate.pure.eventProjectors)) {
      if (!(key in explicit)) explicit[key] = inherit;
    }
    const builder = this as unknown as ProjectionBuilderImpl<AggregateStateOf<TAggregate>>;
    builder._fromStream = {
      aggregate,
      handlers: this._resolveHandlers<AggregateStateOf<TAggregate>>(aggregate, explicit)
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
    this._joinStreams.push({ aggregate, handlers: handlersMap });
    return this;
  }

  hooks(hooks: ProjectionHooks<TState>): ProjectionBuilder<TState> {
    this._hooks = { ...this._hooks, ...hooks };
    return this;
  }

  deduplication(strategy: ProjectionDeduplicationStrategy): ProjectionCommitBuilder<TState> {
    if (strategy.strategy === 'none' && strategy.reason.trim().length === 0) {
      throw new Error(`Projection '${this._name}': none deduplication requires a reason.`);
    }
    this._deduplication = strategy;
    return this;
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
      joinStreams: this._joinStreams,
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
