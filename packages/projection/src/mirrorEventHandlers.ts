import { resolveEventHandlers } from './resolvedEventHandlers';

/** Fill canonical defaults only after explicit handlers have been resolved. */
export function mirrorEventHandlers<T>(
  aggregate: { pure: { eventProjectors: Record<string, unknown> } },
  explicit: Record<string, unknown>,
  resolved: Record<string, T>,
  inherited: T
): Record<string, T> {
  const types = 'types' in aggregate ? aggregate.types : undefined;
  const names = types && typeof types === 'object' && 'events' in types ? types.events : undefined;
  const defaults =
    names && typeof names === 'object'
      ? Object.values(names).filter((name): name is string => typeof name === 'string')
      : Object.keys(aggregate.pure.eventProjectors);
  // A suppressed alias must suppress its wire even if another generated alias exists.
  const explicitWires = new Set(Object.keys(explicit).flatMap((key) => Object.keys(resolveEventHandlers(aggregate, { [key]: true }))));
  for (const name of new Set(defaults)) {
    if (!explicitWires.has(name)) {
      Object.defineProperty(resolved, name, { value: inherited, enumerable: true, writable: true, configurable: true });
    }
  }
  return resolved;
}
