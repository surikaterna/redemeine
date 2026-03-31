import { classifyRetryableError, computeNextAttemptAt } from './RetryPolicy';
import {
  SagaRuntimeAggregate,
  type SagaRuntimeIntentState
} from './SagaRuntimeAggregate';
import type { SagaCommandMap } from './createSaga';
import type { PendingIntentRecord } from './PendingIntentProjection';
import type { RuntimeIntentProjectionRecord } from './RuntimeIntentProjection';
import {
  decidePendingIntentRoute,
  executePendingIntentRouteDecision,
  type SagaIntentRouteDecision,
  type SagaIntentWorkerHandlers
} from './SagaIntentRouter';

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
  readonly record: PendingIntentRecord<TCommandMap>;
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

export interface PendingIntentRecordLookup<TCommandMap extends SagaCommandMap = SagaCommandMap> {
  getByIntentKey(intentKey: string): PendingIntentRecord<TCommandMap> | undefined;
}

export interface RouteDueRuntimeIntentOptions {
  readonly now?: () => string | Date;
  readonly createTimestamp?: () => string;
  readonly retryJitter?: number;
  readonly onResult?: (result: SagaIntentExecutionResult) => void;
}

export class MissingPendingIntentRecordForRuntimeIntentError extends Error {
  readonly intentKey: string;
  readonly sagaStreamId: string;

  constructor(runtimeRecord: RuntimeIntentProjectionRecord) {
    super(
      `Unable to execute runtime intent '${runtimeRecord.intentKey}' on stream '${runtimeRecord.sagaStreamId}' because no pending intent record exists.`
    );
    this.name = 'MissingPendingIntentRecordForRuntimeIntentError';
    this.intentKey = runtimeRecord.intentKey;
    this.sagaStreamId = runtimeRecord.sagaStreamId;
  }
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return String(error);
}

function decideFromRuntimeIntentState<TCommandMap extends SagaCommandMap>(
  record: PendingIntentRecord<TCommandMap>,
  routeDecision: SagaIntentRouteDecision,
  runtimeIntentState: SagaRuntimeIntentState | undefined,
  now: string
): SagaIntentExecutionDecision<TCommandMap> {
  if (!runtimeIntentState) {
    return {
      shouldExecute: false,
      reason: 'skip-intent-not-found',
      record,
      routeDecision
    };
  }

  if (runtimeIntentState.status === 'completed') {
    return {
      shouldExecute: false,
      reason: 'no-op-already-completed',
      record,
      routeDecision
    };
  }

  if (runtimeIntentState.status === 'dead_lettered') {
    return {
      shouldExecute: false,
      reason: 'no-op-already-dead-lettered',
      record,
      routeDecision
    };
  }

  if (runtimeIntentState.status === 'in_progress') {
    return {
      shouldExecute: false,
      reason: 'no-op-already-in-progress',
      record,
      routeDecision
    };
  }

  if (runtimeIntentState.status === 'failed') {
    return {
      shouldExecute: false,
      reason: 'skip-failed-awaiting-transition',
      record,
      routeDecision
    };
  }

  if (runtimeIntentState.status === 'retry_scheduled' && runtimeIntentState.nextAttemptAt && runtimeIntentState.nextAttemptAt > now) {
    return {
      shouldExecute: false,
      reason: 'skip-not-due',
      record,
      routeDecision
    };
  }

  return {
    shouldExecute: true,
    reason: 'execute',
    record,
    routeDecision
  };
}

/**
 * Decision phase for due intent execution.
 *
 * Loads runtime state through Depot and decides if execution should proceed,
 * without invoking worker side-effects.
 */
export async function decideDueSagaIntentExecution<TCommandMap extends SagaCommandMap>(
  record: PendingIntentRecord<TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  options: DecideDueSagaIntentExecutionOptions = {}
): Promise<SagaIntentExecutionTicket<TCommandMap>> {
  const now = toIsoString((options.now ?? (() => new Date()))());
  const runtimeAggregate = await runtimeDepot.get(record.sagaStreamId);
  const routeDecision = decidePendingIntentRoute(record);
  const runtimeIntentState = runtimeAggregate.intents[record.intentKey];

  return {
    decision: decideFromRuntimeIntentState(record, routeDecision, runtimeIntentState, now),
    runtimeAggregate
  };
}

/**
 * Execution phase for a precomputed due intent decision.
 *
 * Applies runtime lifecycle commands (`startIntent`, terminal transitions)
 * through the Depot-loaded Mirage and persists in one Depot save boundary.
 */
export async function executeSagaIntentExecutionTicket<TCommandMap extends SagaCommandMap>(
  ticket: SagaIntentExecutionTicket<TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: ExecuteSagaIntentExecutionTicketOptions = {}
): Promise<SagaIntentExecutionResult> {
  const { decision, runtimeAggregate } = ticket;

  if (!decision.shouldExecute) {
    return {
      intentKey: decision.record.intentKey,
      executed: false,
      outcome: 'skipped',
      reason: decision.reason
    };
  }

  const createTimestamp = options.createTimestamp ?? (() => new Date().toISOString());
  const currentIntentState = runtimeAggregate.intents[decision.record.intentKey];
  const attempt = (currentIntentState?.attempts ?? 0) + 1;

  runtimeAggregate.dispatch(SagaRuntimeAggregate.commandCreators.startIntent({
    intentKey: decision.record.intentKey,
    startedAt: createTimestamp()
  }));

  try {
    await executePendingIntentRouteDecision(
      {
        decision: decision.routeDecision,
        record: decision.record
      },
      handlers
    );

    runtimeAggregate.dispatch(SagaRuntimeAggregate.commandCreators.completeIntent({
      intentKey: decision.record.intentKey,
      completedAt: createTimestamp()
    }));

    await runtimeDepot.save(runtimeAggregate);

    return {
      intentKey: decision.record.intentKey,
      executed: true,
      outcome: 'completed'
    };
  } catch (error) {
    const failedAt = createTimestamp();
    const errorMessage = normalizeErrorMessage(error);

    runtimeAggregate.dispatch(SagaRuntimeAggregate.commandCreators.failIntent({
      intentKey: decision.record.intentKey,
      failedAt,
      errorMessage
    }));

    if (decision.record.intent.type === 'run-activity' && decision.record.intent.retryPolicy) {
      const classification = classifyRetryableError(error);
      const retryPolicy = decision.record.intent.retryPolicy;

      if (classification === 'retryable' && attempt < retryPolicy.maxAttempts) {
        const nextAttemptAt = computeNextAttemptAt(
          retryPolicy,
          attempt,
          failedAt,
          options.retryJitter
        );

        runtimeAggregate.dispatch(SagaRuntimeAggregate.commandCreators.scheduleRetry({
          intentKey: decision.record.intentKey,
          attempt,
          nextAttemptAt,
          scheduledAt: failedAt
        }));

        await runtimeDepot.save(runtimeAggregate);

        return {
          intentKey: decision.record.intentKey,
          executed: true,
          outcome: 'retry-scheduled'
        };
      }

      runtimeAggregate.dispatch(SagaRuntimeAggregate.commandCreators.deadLetterIntent({
        intentKey: decision.record.intentKey,
        attempt,
        reason: classification === 'non-retryable' ? 'non-retryable' : 'max-attempts-exhausted',
        errorMessage,
        deadLetteredAt: failedAt
      }));
    } else {
      runtimeAggregate.dispatch(SagaRuntimeAggregate.commandCreators.deadLetterIntent({
        intentKey: decision.record.intentKey,
        attempt,
        reason: 'non-retryable',
        errorMessage,
        deadLetteredAt: failedAt
      }));
    }

    await runtimeDepot.save(runtimeAggregate);

    return {
      intentKey: decision.record.intentKey,
      executed: true,
      outcome: 'dead-lettered'
    };
  }
}

export async function routeDueRuntimeIntentRecord<TCommandMap extends SagaCommandMap>(
  runtimeRecord: RuntimeIntentProjectionRecord,
  pendingIntentLookup: PendingIntentRecordLookup<TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: RouteDueRuntimeIntentOptions = {}
): Promise<SagaIntentExecutionResult> {
  const pendingRecord = pendingIntentLookup.getByIntentKey(runtimeRecord.intentKey);
  if (!pendingRecord) {
    throw new MissingPendingIntentRecordForRuntimeIntentError(runtimeRecord);
  }

  const ticket = await decideDueSagaIntentExecution(pendingRecord, runtimeDepot, {
    now: options.now
  });

  const result = await executeSagaIntentExecutionTicket(ticket, runtimeDepot, handlers, {
    createTimestamp: options.createTimestamp,
    retryJitter: options.retryJitter
  });

  options.onResult?.(result);
  return result;
}

export function createRuntimeIntentProcessTick<TCommandMap extends SagaCommandMap>(
  runtimeProjection: RuntimeIntentProjectionDueReader,
  pendingIntentLookup: PendingIntentRecordLookup<TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: RouteDueRuntimeIntentOptions = {}
): () => Promise<number> {
  const now = options.now ?? (() => new Date());

  return async () => {
    const dueIntents = runtimeProjection.getDueIntents(now());
    let executedCount = 0;

    for (const dueIntent of dueIntents) {
      const result = await routeDueRuntimeIntentRecord(dueIntent, pendingIntentLookup, runtimeDepot, handlers, {
        ...options,
        now
      });
      if (result.executed) {
        executedCount += 1;
      }
    }

    return executedCount;
  };
}

export function createRuntimeStartupRecoveryScan<TCommandMap extends SagaCommandMap>(
  runtimeProjection: RuntimeIntentProjectionDueReader,
  pendingIntentLookup: PendingIntentRecordLookup<TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: RouteDueRuntimeIntentOptions = {}
): () => Promise<number> {
  return createRuntimeIntentProcessTick(runtimeProjection, pendingIntentLookup, runtimeDepot, handlers, options);
}
