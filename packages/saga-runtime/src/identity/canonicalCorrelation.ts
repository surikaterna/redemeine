export const DEFAULT_CORRELATION_STRING_MAX_BYTES = 512;

export type SagaCanonicalCorrelation = { readonly type: 'string'; readonly value: string } | { readonly type: 'number'; readonly value: number };

export type CorrelationNormalizationErrorCode =
  | 'invalid_correlation_type'
  | 'empty_correlation_string'
  | 'correlation_string_too_large'
  | 'non_canonical_correlation_string'
  | 'invalid_correlation_integer';

export class CorrelationNormalizationError extends Error {
  readonly code: CorrelationNormalizationErrorCode;

  constructor(code: CorrelationNormalizationErrorCode, message: string) {
    super(message);
    this.name = 'CorrelationNormalizationError';
    this.code = code;
  }
}

function validateString(value: string, maxStringBytes: number, requireCanonical: boolean): string {
  const normalized = value.normalize('NFC');
  if (normalized.length === 0) {
    throw new CorrelationNormalizationError('empty_correlation_string', 'Correlation strings must not be empty');
  }
  if (new TextEncoder().encode(normalized).byteLength > maxStringBytes) {
    throw new CorrelationNormalizationError('correlation_string_too_large', `Correlation strings must not exceed ${maxStringBytes} UTF-8 bytes`);
  }
  if (requireCanonical && normalized !== value) {
    throw new CorrelationNormalizationError('non_canonical_correlation_string', 'Correlation strings must be NFC-normalized');
  }
  return normalized;
}

function validateMaxBytes(maxStringBytes: number): void {
  if (!Number.isSafeInteger(maxStringBytes) || maxStringBytes <= 0) {
    throw new RangeError('maxStringBytes must be a positive safe integer');
  }
}

export function normalizeSagaCorrelation(value: unknown, maxStringBytes: number = DEFAULT_CORRELATION_STRING_MAX_BYTES): SagaCanonicalCorrelation {
  validateMaxBytes(maxStringBytes);
  if (typeof value === 'string') return { type: 'string', value: validateString(value, maxStringBytes, false) };
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new CorrelationNormalizationError('invalid_correlation_integer', 'Numeric correlations must be safe integers other than -0');
    }
    return { type: 'number', value };
  }
  throw new CorrelationNormalizationError('invalid_correlation_type', 'Correlations must be non-empty strings or safe integers');
}

export function assertCanonicalSagaCorrelation(correlation: SagaCanonicalCorrelation, maxStringBytes: number = DEFAULT_CORRELATION_STRING_MAX_BYTES): void {
  validateMaxBytes(maxStringBytes);
  if (correlation.type === 'string') {
    validateString(correlation.value, maxStringBytes, true);
    return;
  }
  if (!Number.isSafeInteger(correlation.value) || Object.is(correlation.value, -0)) {
    throw new CorrelationNormalizationError('invalid_correlation_integer', 'Numeric correlations must be safe integers other than -0');
  }
}

export function serializeSagaCorrelation(correlation: SagaCanonicalCorrelation): string {
  assertCanonicalSagaCorrelation(correlation);
  return correlation.type === 'string' ? JSON.stringify(['string', correlation.value]) : JSON.stringify(['number', correlation.value.toString(10)]);
}
