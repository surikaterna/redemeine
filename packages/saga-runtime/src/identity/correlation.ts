import { type SagaCanonicalCorrelation, serializeSagaCorrelation } from './canonicalCorrelation';

export {
  assertCanonicalSagaCorrelation,
  CorrelationNormalizationError,
  type CorrelationNormalizationErrorCode,
  DEFAULT_CORRELATION_STRING_MAX_BYTES,
  normalizeSagaCorrelation,
  type SagaCanonicalCorrelation,
  serializeSagaCorrelation
} from './canonicalCorrelation';

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

export function assertMatchingSagaCorrelations(startCorrelation: SagaCanonicalCorrelation, onCorrelation: SagaCanonicalCorrelation): SagaCanonicalCorrelation {
  if (serializeSagaCorrelation(startCorrelation) !== serializeSagaCorrelation(onCorrelation)) {
    throw new CorrelationMismatchError(startCorrelation, onCorrelation);
  }
  return startCorrelation;
}
