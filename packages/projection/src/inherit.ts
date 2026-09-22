import type { ProjectionContext } from './projectionTypes';
import type { ProjectionEvent } from './types';

// --- inherit token ---

const INHERIT_BRAND = Symbol('inherit');
declare const INHERIT_TYPE_UNSPECIFIED: unique symbol;
type InheritTypeUnspecified = typeof INHERIT_TYPE_UNSPECIFIED;
type TypedInheritExtended<TState, TEvent> = {
  readonly __inheritBrand: typeof INHERIT_BRAND;
  readonly after: (state: TState, event: TEvent, context: ProjectionContext) => void;
};
type ResolveInheritType<T> = T extends InheritTypeUnspecified ? unknown : T;
type LegacyCompatibleInheritAfter<TState, TEvent> = {
  // Preserve legacy defaults independently; fully explicit callbacks remain contravariant.
  bivarianceHack(
    state: ResolveInheritType<TState>,
    event: ResolveInheritType<TEvent>,
    context: ProjectionContext
  ): void;
}['bivarianceHack'];
type LegacyCompatibleInheritExtended<TState, TEvent> = {
  readonly __inheritBrand: typeof INHERIT_BRAND;
  readonly after: LegacyCompatibleInheritAfter<TState, TEvent>;
};

export type InheritExtended<TState = InheritTypeUnspecified, TEvent = InheritTypeUnspecified> =
  [TState] extends [InheritTypeUnspecified]
    ? LegacyCompatibleInheritExtended<TState, TEvent>
    : [TEvent] extends [InheritTypeUnspecified]
      ? LegacyCompatibleInheritExtended<TState, TEvent>
      : TypedInheritExtended<TState, TEvent>;

export interface InheritToken {
  readonly __inheritBrand: typeof INHERIT_BRAND;
  extend<TState, TEvent>(after: (state: TState, event: TEvent, context: ProjectionContext) => void): InheritExtended<TState, TEvent>;
}

function extendInherit<TState, TEvent>(after: (state: TState, event: TEvent, context: ProjectionContext) => void): InheritExtended<TState, TEvent>;
function extendInherit(after: (state: never, event: never, context: ProjectionContext) => void) {
  return Object.freeze({ __inheritBrand: INHERIT_BRAND, after });
}

export const inherit: InheritToken = Object.freeze({
  __inheritBrand: INHERIT_BRAND,
  extend: extendInherit
});

export function isInheritEntry(value: unknown): value is InheritToken {
  return typeof value === 'object' && value !== null && '__inheritBrand' in value && value.__inheritBrand === INHERIT_BRAND;
}

export function isInheritExtended(value: unknown): value is InheritExtended {
  return isInheritEntry(value) && 'after' in value;
}

export function defaultIdentity(event: ProjectionEvent): string {
  return event.aggregateId;
}
