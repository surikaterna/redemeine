import type { SagaAggregateDefinition, SagaCorrelationFactory, SagaDefinition, SagaHandler } from '@redemeine/saga';
import type { SagaCanonicalCorrelation } from '../identity/canonicalCorrelation';

export interface SagaStartEventBinding<TDefinition extends SagaDefinition = SagaDefinition> {
  readonly definition: TDefinition;
  readonly triggerIndex: number;
  readonly eventTypes: readonly string[];
}

export interface CompiledSagaStartRoute {
  readonly kind: 'start';
  readonly routeId: string;
  readonly sagaKey: string;
  readonly definitionVersion: number;
  readonly eventType: string;
  readonly triggerIndex: number;
  readonly definition: SagaDefinition;
  readonly toStartInput: (trigger: unknown) => unknown;
  readonly correlate: (startInput: unknown) => unknown;
}

export interface CompiledSagaOnRoute {
  readonly kind: 'on';
  readonly routeId: string;
  readonly sagaKey: string;
  readonly definitionVersion: number;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly handlerKey: string;
  readonly definition: SagaDefinition;
  readonly handler: SagaHandler<unknown, SagaAggregateDefinition, string>;
  readonly correlate: SagaCorrelationFactory;
}

export type CompiledSagaRoute = CompiledSagaStartRoute | CompiledSagaOnRoute;

export interface CompiledSagaRoutingTable {
  readonly definitions: readonly SagaDefinition[];
  readonly routes: readonly CompiledSagaRoute[];
  readonly routesByEventType: ReadonlyMap<string, readonly CompiledSagaRoute[]>;
}

export interface SagaRouteSourceEvent {
  readonly type: string;
  readonly payload: unknown;
  readonly partitionId: string;
  readonly streamId: string;
  readonly commitId: string;
  readonly eventIndex: number;
  readonly eventId: string;
}

export interface MatchedSagaRoute {
  readonly route: CompiledSagaRoute;
  readonly sourceTriggerId: string;
  readonly eventId: string;
}

export interface SagaRouteCorrelationAgreement {
  readonly start: SagaCanonicalCorrelation;
  readonly on: SagaCanonicalCorrelation;
}

export type SagaRouteCompilationErrorCode =
  | 'duplicate_active_definition'
  | 'invalid_start_binding'
  | 'duplicate_start_binding'
  | 'missing_event_type_map'
  | 'unknown_handler_event'
  | 'duplicate_handler_route'
  | 'missing_route_correlation'
  | 'duplicate_route_correlation';

export class SagaRouteCompilationError extends Error {
  readonly code: SagaRouteCompilationErrorCode;

  constructor(code: SagaRouteCompilationErrorCode, message: string) {
    super(message);
    this.name = 'SagaRouteCompilationError';
    this.code = code;
  }
}
