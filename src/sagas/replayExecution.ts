import type {
  SagaCancelScheduleIntent,
  SagaCommandMap,
  SagaDispatchIntent,
  SagaReducerOutput,
  SagaRunActivityIntent,
  SagaScheduleIntent
} from './createSaga';
import { translateSagaReducerOutputToRuntimeCommands } from './internal/translateSagaReducerOutputToRuntimeCommands';

export interface SagaIntentExecutors<TCommandMap extends SagaCommandMap> {
  dispatch?: (intent: SagaDispatchIntent<TCommandMap>) => unknown | Promise<unknown>;
  schedule?: (intent: SagaScheduleIntent) => unknown | Promise<unknown>;
  cancelSchedule?: (intent: SagaCancelScheduleIntent) => unknown | Promise<unknown>;
  runActivity?: (intent: SagaRunActivityIntent) => unknown | Promise<unknown>;
}

/** Outcome emitted per intent during replay-mode suppression. */
export interface SagaReplayIntentOutcome {
  readonly intentType: 'dispatch' | 'schedule' | 'cancel-schedule' | 'run-activity';
  readonly executed: false;
  readonly reason: 'replay-mode-suppressed';
}

/** Replay-mode result preserving state and suppressed intent outcomes. */
export interface SagaReplayExecutionResult<TState> {
  readonly state: TState;
  readonly outcomes: readonly SagaReplayIntentOutcome[];
}

/**
 * Processes reducer output in replay mode.
 *
 * Intents are converted into non-executed outcomes so callers can inspect
 * what would have happened without physically executing side-effects.
 */
export async function executeSagaReducerOutputInReplay<TState, TCommandMap extends SagaCommandMap>(
  output: SagaReducerOutput<TState, TCommandMap>,
  _executors?: SagaIntentExecutors<TCommandMap>
): Promise<SagaReplayExecutionResult<TState>> {
  const runtimeCommands = translateSagaReducerOutputToRuntimeCommands(output);

  return {
    state: output.state,
    outcomes: runtimeCommands.map(runtimeCommand => ({
      intentType: runtimeCommand.payload.intentType as SagaReplayIntentOutcome['intentType'],
      executed: false,
      reason: 'replay-mode-suppressed'
    }))
  };
}
