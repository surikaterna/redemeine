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
