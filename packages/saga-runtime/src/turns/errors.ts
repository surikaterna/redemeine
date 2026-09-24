export type SagaTurnErrorKind = 'transient' | 'permanent' | 'integrity' | 'unsupported';

export class SagaTurnError extends Error {
  readonly kind: SagaTurnErrorKind;
  readonly retryable: boolean;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    kind: SagaTurnErrorKind,
    retryable: boolean,
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SagaTurnError';
    this.kind = kind;
    this.retryable = retryable;
    this.code = code;
    this.details = details;
  }
}

export class SagaTurnTransientError extends SagaTurnError {
  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super('transient', true, code, message, details, cause);
    this.name = 'SagaTurnTransientError';
  }
}

export class SagaTurnPermanentError extends SagaTurnError {
  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super('permanent', false, code, message, details, cause);
    this.name = 'SagaTurnPermanentError';
  }
}

export class SagaTurnIntegrityError extends SagaTurnError {
  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super('integrity', false, code, message, details, cause);
    this.name = 'SagaTurnIntegrityError';
  }
}

export class SagaTurnUnsupportedError extends SagaTurnError {
  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super('unsupported', false, code, message, details);
    this.name = 'SagaTurnUnsupportedError';
  }
}
