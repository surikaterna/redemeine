import { RedemineError } from '@redemeine/kernel';

/**
 * Thrown when command processing fails due to an unknown command type or handler error.
 */
export class CommandProcessingError extends RedemineError {
  constructor(
    public readonly commandType: string,
    public readonly reason: string,
    options?: ErrorOptions
  ) {
    super(`Command "${commandType}" processing failed: ${reason}`, options);
    this.name = 'CommandProcessingError';
  }
}

/**
 * Thrown when an event has no matching handler in the aggregate.
 */
export class UnmatchedEventError extends RedemineError {
  constructor(
    public readonly eventType: string,
    public readonly aggregateType: string,
    options?: ErrorOptions
  ) {
    super(`Event "${eventType}" has no handler in aggregate "${aggregateType}"`, options);
    this.name = 'UnmatchedEventError';
  }
}
