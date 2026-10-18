import type { AggregatePluginEvents, AggregatePluginSource } from './types';

export function assertSynchronous(value: unknown): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || !('then' in value)) return;
  try {
    if (typeof value.then !== 'function') return;
  } catch {
    // Throwing then getters are also refused, never allowed to escape observation.
  }
  // Observe already-started work; fresh assimilation also catches throwing getters/methods.
  void new Promise<unknown>(resolve => resolve(value)).catch(() => undefined);
  throw new TypeError('Aggregate event plugin callbacks must be synchronous');
}

export function guardCallback<F extends (...args: never[]) => unknown>(callback: F): F {
  // Preserve the callback signature while checking values from JavaScript or widened functions.
  return ((...args: Parameters<F>): ReturnType<F> => {
    const result = callback(...args) as ReturnType<F>;
    assertSynchronous(result);
    return result;
  }) as F;
}

export function snapshotEvents<S, A>(events: AggregatePluginEvents<S, A>): Readonly<AggregatePluginEvents<S, A>> {
  // Object.entries loses the mapped key/signature relationship; wrapping does not change it.
  const entries = Object.entries(events).filter(([, handler]) => handler !== undefined);
  return Object.freeze(Object.fromEntries(entries.map(([key, handler]) => [key, guardCallback(handler as (...args: never[]) => undefined)]))) as Readonly<AggregatePluginEvents<S, A>>;
}

export function eventTypesFor(source: AggregatePluginSource | undefined, keys: string[]): Readonly<Record<string, string>> {
  const types = source && 'types' in source ? source.types : undefined;
  const names = types && typeof types === 'object' && 'events' in types ? types.events : undefined;
  const entries = keys.map(key => {
    const mapped: unknown = names && typeof names === 'object' && Object.hasOwn(names, key) ? Reflect.get(names, key) : undefined;
    return [key, typeof mapped === 'string' ? mapped : key] as const;
  });
  if (new Set(entries.map(([, type]) => type)).size !== entries.length) throw new Error('Ambiguous aggregate plugin event handler');
  return Object.freeze(Object.fromEntries(entries));
}
