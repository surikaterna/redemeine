import type { ReadonlyDeep } from '../../../../utils/types/ReadonlyDeep';
import type { SagaRuntimeIntentState, SagaRuntimeState } from './types';

export function shouldActivateSagaFromObservation(
  state: ReadonlyDeep<SagaRuntimeState>,
  payload: { readonly isStart: boolean }
): boolean {
  return state.lifecycle === 'idle' && payload.isStart;
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

/**
 * Deterministic instance-key derivation for one saga type + correlation value.
 */
export function deriveSagaRuntimeInstanceKey(
  sagaType: string,
  correlation: unknown
): string {
  return `${sagaType}:${hashString(stableSerialize(correlation))}`;
}

export function requireIntent(state: ReadonlyDeep<SagaRuntimeState>, intentKey: string): ReadonlyDeep<SagaRuntimeIntentState> {
  const intent = state.intents[intentKey];
  if (!intent) {
    throw new Error(`Unknown intent '${intentKey}'.`);
  }

  return intent;
}

export function assertIntentNotTerminal(intent: ReadonlyDeep<SagaRuntimeIntentState>): void {
  if (intent.status === 'completed' || intent.status === 'dead_lettered') {
    throw new Error(`Intent '${intent.intentKey}' is terminal and cannot transition from '${intent.status}'.`);
  }
}

export function pushUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}
