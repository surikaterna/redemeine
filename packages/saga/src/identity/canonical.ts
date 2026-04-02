export interface CanonicalSagaIdentityParts {
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
}

export const SAGA_NAMESPACE_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)*$/;
export const SAGA_NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const SAGA_VERSION_TOKEN_PATTERN = /^[1-9][0-9]*$/;

export const SAGA_URN_PREFIX = 'urn:redemeine:saga';

export function normalizeSagaNamespace(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeSagaName(value: string): string {
  return value.trim().toLowerCase();
}

export function buildCanonicalSagaType(identity: CanonicalSagaIdentityParts): string {
  const { namespace, name, version } = identity;
  return `${namespace}.${name}.v${version}`;
}

export function buildCanonicalSagaUrn(identity: CanonicalSagaIdentityParts): string {
  const { namespace, name, version } = identity;
  return `${SAGA_URN_PREFIX}:${namespace}:${name}:v${version}`;
}

export function buildCanonicalSagaInstanceUrn(identity: CanonicalSagaIdentityParts, instanceId: string): string {
  return `${buildCanonicalSagaUrn(identity)}:instance:${instanceId}`;
}
