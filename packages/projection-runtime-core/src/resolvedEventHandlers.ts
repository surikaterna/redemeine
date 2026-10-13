export type ResolvedHandlerEventType<A, K extends string> = A extends { types: { events: infer Names } }
  ? K extends keyof Names ? Extract<Names[K], string> : string
  : K | `${A extends { aggregateType: infer Name extends string } ? Name : string}.${K}.event`;

export function resolveEventHandlers<T>(aggregate: object, handlers: Record<string, T>): Record<string, T> {
  const types = 'types' in aggregate ? aggregate.types : undefined;
  const names = types && typeof types === 'object' && 'events' in types ? types.events : undefined;
  if (!names || typeof names !== 'object') return handlers;
  const resolved: Record<string, T> = {};
  for (const [key, handler] of Object.entries(handlers)) {
    const mapped: unknown = Object.hasOwn(names, key) ? Reflect.get(names, key) : undefined;
    const eventType = typeof mapped === 'string' ? mapped : key;
    if (Object.hasOwn(resolved, eventType)) throw new Error(`Ambiguous projection event handler: ${eventType}`);
    Object.defineProperty(resolved, eventType, { value: handler, enumerable: true, writable: true, configurable: true });
  }
  return resolved;
}
