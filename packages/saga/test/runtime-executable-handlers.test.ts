import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  runSagaErrorHandler,
  runSagaResponseHandler,
  type CanonicalSagaIdentityInput,
  type SagaDefinition,
  type SagaIntent
} from '../src';

type RuntimeTestState = {
  attempts: number;
  lastResult?: string;
  lastError?: string;
};

const RUNTIME_RESPONSE_HANDLER_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'runtime',
  name: 'response_handler',
  version: 1
};

const RUNTIME_ERROR_HANDLER_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'runtime',
  name: 'error_handler',
  version: 1
};

const RUNTIME_HANDLER_FAILURES_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'runtime',
  name: 'handler_failures',
  version: 1
};

const RUNTIME_HANDLER_ERROR_FAILURES_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'runtime',
  name: 'handler_error_failures',
  version: 1
};

describe('runtime executable saga handlers', () => {
  it('runs response handler by token and returns deterministic reducer output', async () => {
    const saga = createSaga<RuntimeTestState>({ identity: RUNTIME_RESPONSE_HANDLER_IDENTITY })
      .onResponses({
        'billing.charge.ok': (state, response, ctx) => {
          state.attempts += 1;
          state.lastResult = String(response.payload);
          ctx.schedule('retry-timeout', 1_000, { correlationId: 'corr-override' });
        }
      })
      .build();

    const result = await runSagaResponseHandler({
      definition: saga,
      state: { attempts: 2 },
      envelope: {
        token: 'billing.charge.ok',
        payload: 'accepted',
        request: {
          plugin_key: 'billing',
          action_name: 'charge',
          sagaId: 'saga-1',
          correlationId: 'corr-1',
          causationId: 'cause-1'
        }
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.token).toBe('billing.charge.ok');
    expect(result.output.state).toEqual({
      attempts: 3,
      lastResult: 'accepted'
    });

    const intents = result.output.intents as readonly SagaIntent[];
    expect(intents).toEqual([
      {
        type: 'schedule',
        id: 'retry-timeout',
        delay: 1_000,
        metadata: {
          sagaId: 'saga-1',
          correlationId: 'corr-override',
          causationId: 'cause-1'
        }
      }
    ]);
  });

  it('runs error handler by token and returns deterministic reducer output', async () => {
    const saga = createSaga<RuntimeTestState>({ identity: RUNTIME_ERROR_HANDLER_IDENTITY })
      .onErrors({
        'billing.charge.failed': (state, error, ctx) => {
          state.attempts += 1;
          state.lastError = String(error.error);
          ctx.cancelSchedule('retry-timeout');
        }
      })
      .build();

    const result = await runSagaErrorHandler({
      definition: saga,
      state: { attempts: 1 },
      envelope: {
        token: 'billing.charge.failed',
        error: 'declined',
        request: {
          plugin_key: 'billing',
          action_name: 'charge',
          sagaId: 'saga-2',
          correlationId: 'corr-2',
          causationId: 'cause-2'
        }
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.token).toBe('billing.charge.failed');
    expect(result.output.state).toEqual({
      attempts: 2,
      lastError: 'declined'
    });
    expect(result.output.intents).toEqual([
      {
        type: 'cancel-schedule',
        id: 'retry-timeout',
        metadata: {
          sagaId: 'saga-2',
          correlationId: 'corr-2',
          causationId: 'cause-2'
        }
      }
    ]);
  });

  it('returns deterministic failure contract for token lookup and phase mismatch', async () => {
    const saga = createSaga<RuntimeTestState>({ identity: RUNTIME_HANDLER_FAILURES_IDENTITY })
      .onErrors({
        'billing.charge.failed': () => undefined
      })
      .build();
    const untypedSaga = saga as unknown as SagaDefinition<RuntimeTestState, readonly [], any>;

    const missingToken = await runSagaResponseHandler({
      definition: untypedSaga,
      state: { attempts: 0 },
      envelope: {
        token: 'billing.charge.unknown',
        payload: 'ignored',
        request: {
          plugin_key: 'billing',
          action_name: 'charge'
        }
      }
    });

    expect(missingToken).toEqual({
      ok: false,
      reason: 'token_not_defined',
      token: 'billing.charge.unknown'
    });

    const responsePhaseMismatch = await runSagaResponseHandler({
      definition: untypedSaga,
      state: { attempts: 0 },
      envelope: {
        token: 'billing.charge.failed',
        payload: 'ignored',
        request: {
          plugin_key: 'billing',
          action_name: 'charge'
        }
      }
    });

    expect(responsePhaseMismatch).toEqual({
      ok: false,
      reason: 'phase_mismatch',
      token: 'billing.charge.failed',
      expected_phase: 'response',
      actual_phase: 'error'
    });
  });

  it('returns token_not_defined and phase_mismatch for error helper', async () => {
    const saga = createSaga<RuntimeTestState>({ identity: RUNTIME_HANDLER_ERROR_FAILURES_IDENTITY })
      .onResponses({
        'billing.charge.ok': () => undefined
      })
      .onErrors({
        'billing.charge.failed': () => undefined
      })
      .build();
    const untypedSaga = saga as unknown as SagaDefinition<RuntimeTestState, readonly [], any>;

    const unknownToken = await runSagaErrorHandler({
      definition: untypedSaga,
      state: { attempts: 0 },
      envelope: {
        token: 'billing.charge.unknown',
        error: 'ignored',
        request: {
          plugin_key: 'billing',
          action_name: 'charge'
        }
      }
    });

    expect(unknownToken).toEqual({
      ok: false,
      reason: 'token_not_defined',
      token: 'billing.charge.unknown'
    });

    const errorPhaseMismatch = await runSagaErrorHandler({
      definition: untypedSaga,
      state: { attempts: 0 },
      envelope: {
        token: 'billing.charge.ok',
        error: 'ignored',
        request: {
          plugin_key: 'billing',
          action_name: 'charge'
        }
      }
    });

    expect(errorPhaseMismatch).toEqual({
      ok: false,
      reason: 'phase_mismatch',
      token: 'billing.charge.ok',
      expected_phase: 'error',
      actual_phase: 'response'
    });
  });
});
