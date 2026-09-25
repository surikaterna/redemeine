import type { SagaAggregateDefinition, SagaCorrelationFactory, SagaDefinition, SagaHandler, SagaIntent, SagaIntentMetadata } from '@redemeine/saga';
import type { SagaCanonicalCorrelation } from '../identity/canonicalCorrelation';
import type { SagaTurnRegistration } from './registerSagaDefinition';
import type { StartTurnOrigin } from './startIntentValidation';
import type { WireIntent } from '../intentWire';

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
  readonly definition: SagaRouteDefinitionIdentity;
  readonly executeStart?: (input: unknown, metadata: SagaIntentMetadata, origin: StartTurnOrigin, clock: string) => Promise<{ state: object; intents: readonly WireIntent[] }>;
  readonly when?: (trigger: unknown) => boolean;
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
  readonly definition: SagaRouteDefinitionIdentity;
  readonly handler?: SagaHandler<unknown, SagaAggregateDefinition, string>;
  readonly executeOn?: (state: unknown, event: unknown, metadata: SagaIntentMetadata) => Promise<{ state: unknown; intents: readonly SagaIntent[] }>;
  readonly correlate: SagaCorrelationFactory;
}

export type CompiledSagaRoute = CompiledSagaStartRoute | CompiledSagaOnRoute;

export interface SagaRouteDefinitionIdentity {
  readonly sagaKey: string;
  readonly sagaType: string;
  readonly identity: { readonly version: number };
  readonly initialState: () => unknown;
}

export interface CompiledSagaRoutingTable {
  readonly definitions: readonly SagaRouteDefinitionIdentity[];
  readonly registered?: readonly SagaTurnRegistration[];
  readonly legacyDefinitions?: readonly SagaDefinition[];
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
