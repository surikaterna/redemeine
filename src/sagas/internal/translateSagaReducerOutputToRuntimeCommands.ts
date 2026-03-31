import type { Command } from '../../types';
import type { SagaCommandMap, SagaIntent, SagaReducerOutput } from '../createSaga';
import type { SagaRuntimeQueueIntentPayload } from '../SagaRuntimeAggregate';

type SagaRuntimeQueueIntentCommandType = 'sagaRuntime.queueIntent.command';

type SagaRuntimeQueueIntentCommand = Command<
  SagaRuntimeQueueIntentPayload,
  SagaRuntimeQueueIntentCommandType
>;

export interface SagaRuntimeTranslationOptions {
  readonly sagaStreamId: string;
  readonly createQueuedAt?: () => string;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`);

  return `{${entries.join(',')}}`;
}

function hashString(value: string): string {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function createIntentIdempotencyKey<TCommandMap extends SagaCommandMap>(
  sagaStreamId: string,
  intentOrdinal: number,
  intent: SagaIntent<TCommandMap>
): string {
  const intentHash = hashString(stableSerialize(intent));
  return `${sagaStreamId}:${intentOrdinal}:${intentHash}`;
}

/**
 * Internal seam that adapts reducer intent output into runtime aggregate queue commands.
 */
export function translateSagaReducerOutputToRuntimeCommands<TState, TCommandMap extends SagaCommandMap>(
  output: SagaReducerOutput<TState, TCommandMap>,
  options: SagaRuntimeTranslationOptions = { sagaStreamId: 'replay' }
): readonly SagaRuntimeQueueIntentCommand[] {
  return output.intents.map((intent, intentOrdinal) => {
    const idempotencyKey = createIntentIdempotencyKey(options.sagaStreamId, intentOrdinal, intent);

    return {
      type: 'sagaRuntime.queueIntent.command',
      payload: {
        intentKey: idempotencyKey,
        idempotencyKey,
        metadata: intent.metadata,
        intentType: intent.type,
        queuedAt: options.createQueuedAt?.() ?? new Date().toISOString()
      }
    };
  });
}
