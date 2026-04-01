import {
  SagaIdentityNormalizationError,
  type NormalizedSagaIdentity,
  type SagaIdentityInput
} from './types';

const NAMESPACE_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)*$/;
const NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const normalizeNamespace = (namespace: string): string => namespace.trim().toLowerCase();

const normalizeName = (name: string): string => name.trim().toLowerCase();

const normalizeVersion = (version: SagaIdentityInput['version']): number => {
  const parsed = typeof version === 'string'
    ? Number.parseInt(version.trim(), 10)
    : version;

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SagaIdentityNormalizationError(
      'invalid_version',
      'Saga identity version must be a positive integer.'
    );
  }

  return parsed;
};

export function buildSagaType(namespace: string, name: string, version: number): string {
  return `${namespace}.${name}.v${version}`;
}

export function normalizeSagaIdentity(input: SagaIdentityInput): NormalizedSagaIdentity {
  const namespace = normalizeNamespace(input.namespace);
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new SagaIdentityNormalizationError(
      'invalid_namespace',
      'Saga identity namespace must be dot-delimited lowercase alphanumeric segments.'
    );
  }

  const name = normalizeName(input.name);
  if (!NAME_PATTERN.test(name)) {
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
