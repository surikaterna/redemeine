import {
  SagaIdentityNormalizationError,
  type NormalizedSagaIdentity,
  type SagaIdentityInput
} from './types';
import {
  buildCanonicalSagaType,
  normalizeSagaName,
  normalizeSagaNamespace,
  SAGA_NAME_PATTERN,
  SAGA_NAMESPACE_PATTERN,
  SAGA_VERSION_TOKEN_PATTERN
} from './canonical';

const normalizeVersion = (version: SagaIdentityInput['version']): number => {
  const parsed = typeof version === 'string'
    ? (() => {
        const trimmed = version.trim();
        if (!SAGA_VERSION_TOKEN_PATTERN.test(trimmed)) {
          return Number.NaN;
        }

        return Number(trimmed);
      })()
    : version;

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new SagaIdentityNormalizationError(
      'invalid_version',
      'Saga identity version must be a positive integer.'
    );
  }

  return parsed;
};

export function buildSagaType(namespace: string, name: string, version: number): string {
  return buildCanonicalSagaType({ namespace, name, version });
}

export function normalizeSagaIdentity(input: SagaIdentityInput): NormalizedSagaIdentity {
  const namespace = normalizeSagaNamespace(input.namespace);
  if (!SAGA_NAMESPACE_PATTERN.test(namespace)) {
    throw new SagaIdentityNormalizationError(
      'invalid_namespace',
      'Saga identity namespace must be dot-delimited lowercase alphanumeric segments.'
    );
  }

  const name = normalizeSagaName(input.name);
  if (!SAGA_NAME_PATTERN.test(name)) {
    throw new SagaIdentityNormalizationError(
      'invalid_name',
      'Saga identity name must be lowercase alphanumeric and may include . _ - separators.'
    );
  }

  const version = normalizeVersion(input.version);

  return {
    namespace,
    name,
    version,
    sagaType: buildSagaType(namespace, name, version)
  };
}
