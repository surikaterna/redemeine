export interface SagaIdentityParts {
  namespace: string;
  name: string;
  version: number;
}

export type SagaIdentityInput = {
  namespace: string;
  name: string;
  version: number;
};

export interface NormalizedSagaIdentity extends SagaIdentityParts {
  sagaKey: string;
  sagaType: string;
  sagaUrn: string;
}

export type SagaIdentityNormalizationErrorCode =
  | 'invalid_namespace'
  | 'invalid_name'
  | 'invalid_version';

export class SagaIdentityNormalizationError extends Error {
  readonly code: SagaIdentityNormalizationErrorCode;

  constructor(code: SagaIdentityNormalizationErrorCode, message: string) {
    super(message);
    this.name = 'SagaIdentityNormalizationError';
    this.code = code;
  }
}
