import type { RuntimeIntentProjectionRecord, RuntimeIntentProjectionRecordFor } from '../RuntimeIntentProjection';
import type { SagaIntentRouteDecision, SagaIntentWorkerHandlers } from '../SagaIntentRouter';
import type { SagaCommandMap } from '../../../createSaga';
import type { SagaRuntimeIntentState } from '../SagaRuntimeAggregate';

export interface SagaRuntimeMirageLike {
  dispatch(command: { type: string; payload: unknown }): unknown;
  readonly intents: Record<string, SagaRuntimeIntentState>;
}

export interface SagaRuntimeDepotLike {
  get(id: string): Promise<SagaRuntimeMirageLike>;
  save(mirage: SagaRuntimeMirageLike): Promise<void>;
}

export type SagaIntentExecutionDecisionReason =
  | 'execute'
  | 'skip-intent-not-found'
  | 'skip-not-due'
  | 'no-op-already-completed'
  | 'no-op-already-dead-lettered'
  | 'no-op-already-in-progress'
  | 'skip-failed-awaiting-transition';

export interface SagaIntentExecutionDecision<TCommandMap extends SagaCommandMap = SagaCommandMap> {
  readonly shouldExecute: boolean;
  readonly reason: SagaIntentExecutionDecisionReason;
  readonly record: RuntimeIntentProjectionRecordFor<TCommandMap>;
  readonly routeDecision: SagaIntentRouteDecision;
}

export interface SagaIntentExecutionTicket<TCommandMap extends SagaCommandMap = SagaCommandMap> {
  readonly decision: SagaIntentExecutionDecision<TCommandMap>;
  readonly runtimeAggregate: SagaRuntimeMirageLike;
}

export interface DecideDueSagaIntentExecutionOptions {
  readonly now?: () => string | Date;
}

export interface ExecuteSagaIntentExecutionTicketOptions {
  readonly createTimestamp?: () => string;
  readonly retryJitter?: number;
}

export interface SagaIntentExecutionResult {
  readonly intentKey: string;
  readonly executed: boolean;
  readonly outcome: 'completed' | 'retry-scheduled' | 'dead-lettered' | 'skipped';
  readonly reason?: SagaIntentExecutionDecisionReason;
}

export interface RuntimeIntentProjectionDueReader {
  getDueIntents(now?: string | Date): RuntimeIntentProjectionRecord[];
}

export interface RouteDueRuntimeIntentOptions {
  readonly now?: () => string | Date;
  readonly createTimestamp?: () => string;
  readonly retryJitter?: number;
  readonly onResult?: (result: SagaIntentExecutionResult) => void;
}

export type { RuntimeIntentProjectionRecord, RuntimeIntentProjectionRecordFor, SagaIntentWorkerHandlers, SagaCommandMap };
