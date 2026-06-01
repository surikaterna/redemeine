import { RedemineError } from '@redemeine/kernel';

/**
 * Thrown when replaying events to hydrate a Mirage instance fails.
 *
 * Indicates a corrupt event stream or incompatible aggregate schema change.
 *
 * @since 0.1.0
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
