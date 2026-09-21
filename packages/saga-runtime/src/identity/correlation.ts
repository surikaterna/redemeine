import type { SagaCanonicalCorrelation } from '../sagaAggregateContracts';

export const DEFAULT_CORRELATION_STRING_MAX_BYTES = 512;

export type CorrelationNormalizationErrorCode =
  | 'invalid_correlation_type'
  | 'empty_correlation_string'
  | 'correlation_string_too_large'
  | 'invalid_correlation_integer';

export class CorrelationNormalizationError extends Error {
  readonly code: CorrelationNormalizationErrorCode;

  constructor(code: CorrelationNormalizationErrorCode, message: string) {
    super(message);
    this.name = 'CorrelationNormalizationError';
    this.code = code;
  }
}

export class CorrelationMismatchError extends Error {
  readonly startCorrelation: SagaCanonicalCorrelation;
  readonly onCorrelation: SagaCanonicalCorrelation;

  constructor(startCorrelation: SagaCanonicalCorrelation, onCorrelation: SagaCanonicalCorrelation) {
    super('Start and on-route correlations identify different saga instances');
    this.name = 'CorrelationMismatchError';
    this.startCorrelation = startCorrelation;
    this.onCorrelation = onCorrelation;
  }
}

function normalizeString(value: string, maxStringBytes: number): SagaCanonicalCorrelation {
  const normalized = value.normalize('NFC');
  if (normalized.length === 0) {
    throw new CorrelationNormalizationError('empty_correlation_string', 'Correlation strings must not be empty');
  }
  if (new TextEncoder().encode(normalized).byteLength > maxStringBytes) {
    throw new CorrelationNormalizationError('correlation_string_too_large', `Correlation strings must not exceed ${maxStringBytes} UTF-8 bytes`);
  }
  return { type: 'string', value: normalized };
}

export function normalizeSagaCorrelation(value: unknown, maxStringBytes: number = DEFAULT_CORRELATION_STRING_MAX_BYTES): SagaCanonicalCorrelation {
  if (!Number.isSafeInteger(maxStringBytes) || maxStringBytes <= 0) {
    throw new RangeError('maxStringBytes must be a positive safe integer');
  }
  if (typeof value === 'string') return normalizeString(value, maxStringBytes);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new CorrelationNormalizationError('invalid_correlation_integer', 'Numeric correlations must be safe integers other than -0');
    }
    return { type: 'number', value };
  }
  throw new CorrelationNormalizationError('invalid_correlation_type', 'Correlations must be non-empty strings or safe integers');
}

export function serializeSagaCorrelation(correlation: SagaCanonicalCorrelation): string {
  return correlation.type === 'string' ? JSON.stringify(['string', correlation.value]) : JSON.stringify(['number', correlation.value.toString(10)]);
}

export function assertMatchingSagaCorrelations(startCorrelation: SagaCanonicalCorrelation, onCorrelation: SagaCanonicalCorrelation): SagaCanonicalCorrelation {
  if (serializeSagaCorrelation(startCorrelation) !== serializeSagaCorrelation(onCorrelation)) {
    throw new CorrelationMismatchError(startCorrelation, onCorrelation);
  }
  return startCorrelation;
}
