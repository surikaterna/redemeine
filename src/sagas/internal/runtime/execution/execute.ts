import { classifyRetryableError, computeNextAttemptAt } from '../../../RetryPolicy';
import { SagaRuntimeAggregate } from '../SagaRuntimeAggregate';
import { executePendingIntentRouteDecision } from '../SagaIntentRouter';
import type { SagaCommandMap } from '../../../createSaga';
import type {
  ExecuteSagaIntentExecutionTicketOptions,
  SagaIntentExecutionResult,
  SagaIntentExecutionTicket,
  SagaRuntimeDepotLike,
  SagaIntentWorkerHandlers
} from './contracts';

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return String(error);
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
