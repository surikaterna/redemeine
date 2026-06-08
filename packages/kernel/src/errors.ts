/**
 * Base error class for all Redemeine domain errors.
 *
 * Provides consistent error naming and `cause` chaining support.
 * Extend this class for domain-specific error types.
 *
 * @since 0.1.0
 */
export class RedemineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RedemineError';
  }
}

/**
 * Thrown when contract validation fails for a command or event payload.
 *
 * Contains the contract name and individual validation error messages
 * for diagnostic purposes.
 *
 * @since 0.2.0
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
