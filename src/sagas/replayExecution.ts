import type {
  SagaCancelScheduleIntent,
  SagaCommandMap,
  SagaDispatchIntent,
  SagaReducerOutput,
  SagaRunActivityIntent,
  SagaScheduleIntent
} from './createSaga';

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
  return {
    state: output.state,
    outcomes: output.intents.map(intent => ({
      intentType: intent.type,
      executed: false,
      reason: 'replay-mode-suppressed'
    }))
  };
}
