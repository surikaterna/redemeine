import { RedemineError } from '@redemeine/kernel';

/**
 * Thrown when hydration/replay of an entity from events fails.
 */
export class MirageHydrationError extends RedemineError {
  constructor(
    public readonly entityType: string,
    public readonly reason: string,
    options?: ErrorOptions
  ) {
    super(`Hydration failed for "${entityType}": ${reason}`, options);
    this.name = 'MirageHydrationError';
  }
}
