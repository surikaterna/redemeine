import type { ProjectionEvent } from './types';
import type { ProjectionContext } from './createProjection';

// --- inherit token ---

const INHERIT_BRAND = Symbol('inherit');

export interface InheritExtended<TState = any, TEvent = any> {
  readonly __inheritBrand: typeof INHERIT_BRAND;
  readonly after: (state: TState, event: TEvent, context: ProjectionContext) => void;
}

export interface InheritToken {
  readonly __inheritBrand: typeof INHERIT_BRAND;
  extend<TState, TEvent>(
    after: (state: TState, event: TEvent, context: ProjectionContext) => void
  ): InheritExtended<TState, TEvent>;
}

/**
 * Token that tells a projection to reuse the aggregate's own event projector
 * for a given event type. Use in `.from()` or `.mirror()` handlers to delegate
 * state mutation to the source aggregate's logic.
 *
 * Call `inherit.extend(afterFn)` to run additional logic after the inherited mutation.
 *
 * @example
 * ```typescript
 * const OrderView = createProjection('orderView', () => ({}))
 *   .mirror(OrderAggregate, {
 *     itemAdded: inherit,
 *     orderPlaced: inherit.extend((state, event) => {
 *       state.lastPlacedAt = event.payload.timestamp;
 *     })
 *   })
 *   .build();
 * ```
 *
 * @since 0.1.0
 */
export const inherit: InheritToken = Object.freeze({
  __inheritBrand: INHERIT_BRAND,
  extend<TState, TEvent>(
    after: (state: TState, event: TEvent, context: ProjectionContext) => void
  ): InheritExtended<TState, TEvent> {
    return Object.freeze({ __inheritBrand: INHERIT_BRAND, after });
  }
}) as InheritToken;

export function isInheritEntry(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    '__inheritBrand' in value && (value as any).__inheritBrand === INHERIT_BRAND;
}

export function isInheritExtended(value: unknown): value is InheritExtended {
  return isInheritEntry(value) && 'after' in (value as any);
}

export function defaultIdentity(event: ProjectionEvent): string {
  return event.aggregateId;
}
