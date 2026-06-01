/**
 * Base error class for all redemeine errors.
 * Provides consistent error naming and cause chaining support.
 */
export class RedemineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RedemineError';
  }
}

/**
 * Thrown when contract validation fails for a command or event payload.
 */
export class ContractValidationError extends RedemineError {
  constructor(
    public readonly contractName: string,
    public readonly validationErrors: readonly string[],
    options?: ErrorOptions
  ) {
    super(`Contract "${contractName}" validation failed: ${validationErrors.join(', ')}`, options);
    this.name = 'ContractValidationError';
  }
}
