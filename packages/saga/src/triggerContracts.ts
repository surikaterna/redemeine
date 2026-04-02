import type { SagaStartPolicy } from './startPolicy';

/**
 * Shared trigger contract for saga-start definitions.
 *
 * This is intentionally definition-oriented and can be consumed by future
 * trigger builders without changing runtime behavior in this bead.
 */
export interface SagaTriggerStartContract {
  readonly startPolicy?: SagaStartPolicy;
}
