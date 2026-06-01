import { RedemineError } from '@redemeine/kernel';

/**
 * Thrown when a command cannot be processed by the aggregate.
 *
 * Indicates either an unknown command type or a handler-level failure
 * during command processing.
 *
 * @since 0.2.0
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
 * Thrown when an event type has no registered handler in the aggregate.
 *
 * Configure `.onUnmatchedEvent()` on the aggregate builder to handle
 * this scenario gracefully instead of throwing.
 *
 * @since 0.2.0
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
