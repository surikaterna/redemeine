import type { SagaIntentMetadata } from './createSaga';

export type LegacySagaIdentityObject = {
  saga_id?: unknown;
  correlation_id?: unknown;
  causation_id?: unknown;
};

export type SupportedSagaIdentityInput =
  | SagaIntentMetadata
  | LegacySagaIdentityObject
  | string;

export interface NormalizedSagaIdentityResult {
  identity: SagaIntentMetadata;
  deprecated: boolean;
  deprecationNotes: readonly string[];
}

const LEGACY_TRIPLE_STRING_SEPARATOR = '|';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function assertRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Saga identity field "${field}" must be a non-empty string.`);
  }

  return value;
}

function normalizeCanonicalObject(input: Record<string, unknown>): SagaIntentMetadata | undefined {
  const sagaId = readOptionalString(input.sagaId);
  const correlationId = readOptionalString(input.correlationId);
  const causationId = readOptionalString(input.causationId);

  if (!sagaId && !correlationId && !causationId) {
    return undefined;
  }

  return {
    sagaId: assertRequiredString(sagaId, 'sagaId'),
    correlationId: correlationId ?? assertRequiredString(sagaId, 'sagaId'),
    causationId: causationId ?? correlationId ?? assertRequiredString(sagaId, 'sagaId')
  };
}

function normalizeLegacyObject(input: Record<string, unknown>): SagaIntentMetadata | undefined {
  const sagaId = readOptionalString(input.saga_id);
  const correlationId = readOptionalString(input.correlation_id);
  const causationId = readOptionalString(input.causation_id);

  if (!sagaId && !correlationId && !causationId) {
    return undefined;
  }

  return {
    sagaId: assertRequiredString(sagaId, 'saga_id'),
    correlationId: correlationId ?? assertRequiredString(sagaId, 'saga_id'),
    causationId: causationId ?? correlationId ?? assertRequiredString(sagaId, 'saga_id')
  };
}

function normalizeLegacyString(input: string): SagaIntentMetadata {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new TypeError('Saga identity string input cannot be empty.');
  }

  const parts = trimmed.split(LEGACY_TRIPLE_STRING_SEPARATOR).map((part) => part.trim());
  if (parts.length === 1) {
    return {
      sagaId: parts[0],
      correlationId: parts[0],
      causationId: parts[0]
    };
  }

  if (parts.length === 3 && parts.every((part) => part.length > 0)) {
    return {
      sagaId: parts[0],
      correlationId: parts[1],
      causationId: parts[2]
    };
  }

  throw new TypeError(
    'Unsupported legacy saga identity string format. Supported formats: "<sagaId>" or "<sagaId>|<correlationId>|<causationId>".'
  );
}

/**
 * Backward-compatibility adapter for saga identity inputs.
 *
 * Canonical shape is `{ sagaId, correlationId, causationId }`.
 *
 * Supported legacy inputs:
 * - string: `<sagaId>`
 * - string: `<sagaId>|<correlationId>|<causationId>`
 * - object: `{ saga_id, correlation_id?, causation_id? }`
 */
export function normalizeSagaIdentityInput(input: SupportedSagaIdentityInput): NormalizedSagaIdentityResult {
  if (typeof input === 'string') {
    return {
      identity: normalizeLegacyString(input),
      deprecated: true,
      deprecationNotes: [
        'String-based saga identity inputs are deprecated; pass an object with sagaId/correlationId/causationId.'
      ]
    };
  }

  if (!isRecord(input)) {
    throw new TypeError(
      'Unsupported saga identity input. Expected string or object identity shape with sagaId/correlationId/causationId.'
    );
  }

  const canonical = normalizeCanonicalObject(input);
  if (canonical) {
    return {
      identity: canonical,
      deprecated: false,
      deprecationNotes: []
    };
  }

  const legacy = normalizeLegacyObject(input);
  if (legacy) {
    return {
      identity: legacy,
      deprecated: true,
      deprecationNotes: [
        'Snake_case saga identity fields are deprecated; use sagaId/correlationId/causationId.'
      ]
    };
  }

  throw new TypeError(
    'Unsupported saga identity object shape. Supported object fields: sagaId/correlationId/causationId or legacy saga_id/correlation_id/causation_id.'
  );
}
