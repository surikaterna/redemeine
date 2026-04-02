export {
  buildSagaType,
  normalizeSagaIdentity
} from './normalizeSagaIdentity';

export {
  SagaIdentityNormalizationError,
  type SagaIdentityInput,
  type SagaIdentityNormalizationErrorCode,
  type SagaIdentityParts,
  type NormalizedSagaIdentity
} from './types';

export {
  deriveSagaInstanceUrn,
  deriveSagaUrn,
  type SagaStructuredIdentity
} from './sagaUrn';

export {
  buildCanonicalSagaInstanceUrn,
  normalizeCanonicalIdentitySegment,
  normalizeCanonicalSagaVersion,
  buildCanonicalSagaType,
  buildCanonicalSagaUrn,
  normalizeSagaName,
  normalizeSagaNamespace,
  SAGA_NAME_PATTERN,
  SAGA_NAMESPACE_PATTERN,
  SAGA_URN_PREFIX,
  SAGA_VERSION_TOKEN_PATTERN,
  type CanonicalSagaIdentityParts
} from './canonical';
