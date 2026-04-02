import {
  buildCanonicalSagaUrn,
  SAGA_NAME_PATTERN,
  SAGA_NAMESPACE_PATTERN,
  SAGA_VERSION_TOKEN_PATTERN
} from './identity/canonical';

export interface SagaIdentity {
  namespace: string;
  name: string;
  version: number;
}

export type SagaIdentityErrorCode =
  | 'SAGA_IDENTITY_INVALID_NAMESPACE'
  | 'SAGA_IDENTITY_INVALID_NAME'
  | 'SAGA_IDENTITY_INVALID_VERSION'
  | 'SAGA_IDENTITY_MALFORMED_URN';

export class SagaIdentityValidationError extends Error {
  readonly code: SagaIdentityErrorCode;
  readonly field: 'namespace' | 'name' | 'version' | 'urn';
  readonly value: unknown;

  constructor(args: {
    code: SagaIdentityErrorCode;
    field: 'namespace' | 'name' | 'version' | 'urn';
    value: unknown;
    message: string;
  }) {
    super(args.message);
    this.name = 'SagaIdentityValidationError';
    this.code = args.code;
    this.field = args.field;
    this.value = args.value;
    Object.setPrototypeOf(this, SagaIdentityValidationError.prototype);
  }
}

export function validateSagaNamespace(namespace: string): string {
  if (!SAGA_NAMESPACE_PATTERN.test(namespace)) {
    throw new SagaIdentityValidationError({
      code: 'SAGA_IDENTITY_INVALID_NAMESPACE',
      field: 'namespace',
      value: namespace,
      message:
        'Saga identity namespace must be lowercase dot-delimited segments containing only letters and numbers.'
    });
  }

  return namespace;
}

export function validateSagaName(name: string): string {
  if (!SAGA_NAME_PATTERN.test(name)) {
    throw new SagaIdentityValidationError({
      code: 'SAGA_IDENTITY_INVALID_NAME',
      field: 'name',
      value: name,
      message:
        'Saga identity name must be lowercase and may use ., _, or - as separators between alphanumeric tokens.'
    });
  }

  return name;
}

export function validateSagaVersion(version: number): number {
  if (!Number.isInteger(version) || version < 1 || !Number.isSafeInteger(version)) {
    throw new SagaIdentityValidationError({
      code: 'SAGA_IDENTITY_INVALID_VERSION',
      field: 'version',
      value: version,
      message: 'Saga identity version must be a positive safe integer.'
    });
  }

  return version;
}

export function validateSagaIdentity(identity: SagaIdentity): SagaIdentity {
  validateSagaNamespace(identity.namespace);
  validateSagaName(identity.name);
  validateSagaVersion(identity.version);
  return identity;
}

export function toSagaIdentityUrn(identity: SagaIdentity): string {
  validateSagaIdentity(identity);
  return buildCanonicalSagaUrn(identity);
}

export function parseSagaIdentityUrn(urn: string): SagaIdentity {
  const parts = urn.split(':');
  if (parts.length !== 6 || parts[0] !== 'urn' || parts[1] !== 'redemeine' || parts[2] !== 'saga') {
    throw new SagaIdentityValidationError({
      code: 'SAGA_IDENTITY_MALFORMED_URN',
      field: 'urn',
      value: urn,
      message: 'Saga identity URN must match "urn:redemeine:saga:<namespace>:<name>:v<version>".'
    });
  }

  const [, , , namespace, name, versionToken] = parts;
  if (!versionToken.startsWith('v') || !SAGA_VERSION_TOKEN_PATTERN.test(versionToken.slice(1))) {
    throw new SagaIdentityValidationError({
      code: 'SAGA_IDENTITY_MALFORMED_URN',
      field: 'urn',
      value: urn,
      message: 'Saga identity URN version segment must be "v<integer>".'
    });
  }

  return validateSagaIdentity({
    namespace,
    name,
    version: Number(versionToken.slice(1))
  });
}
