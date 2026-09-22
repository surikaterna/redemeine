import type { ProjectionContext } from './projectionTypes';
import type { ProjectionEvent } from './types';

// --- inherit token ---

const INHERIT_BRAND = Symbol('inherit');

export interface InheritExtended<TState = never, TEvent = never> {
  readonly __inheritBrand: typeof INHERIT_BRAND;
  readonly after: (state: TState, event: TEvent, context: ProjectionContext) => void;
}

export interface InheritToken {
  readonly __inheritBrand: typeof INHERIT_BRAND;
  extend<TState, TEvent>(after: (state: TState, event: TEvent, context: ProjectionContext) => void): InheritExtended<TState, TEvent>;
}

export const inherit: InheritToken = Object.freeze({
  __inheritBrand: INHERIT_BRAND,
  extend<TState, TEvent>(after: (state: TState, event: TEvent, context: ProjectionContext) => void): InheritExtended<TState, TEvent> {
    return Object.freeze({ __inheritBrand: INHERIT_BRAND, after });
  }
}) as InheritToken;

export function isInheritEntry(value: unknown): value is InheritToken {
  return typeof value === 'object' && value !== null && '__inheritBrand' in value && value.__inheritBrand === INHERIT_BRAND;
}

export function isInheritExtended(value: unknown): value is InheritExtended {
  return isInheritEntry(value) && 'after' in value;
}

export function defaultIdentity(event: ProjectionEvent): string {
  return event.aggregateId;
}
