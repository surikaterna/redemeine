type Wrap = (value: unknown) => unknown;
type Visitor = (value: unknown, key: unknown, collection: object) => void;

function denyMutation(): never {
  throw new TypeError('Cannot mutate command state');
}

function* values(source: Iterable<unknown>, wrap: Wrap): IterableIterator<unknown> {
  for (const value of source) yield wrap(value);
}

function* entries(source: Iterable<[unknown, unknown]>, wrap: Wrap): IterableIterator<[unknown, unknown]> {
  for (const [key, value] of source) yield [wrap(key), wrap(value)];
}

export function commandCollectionView(
  source: Map<unknown, unknown> | Set<unknown>, wrap: Wrap, unwrap: Wrap
): object {
  const map = source instanceof Map ? source : undefined;
  const readers = {
    has: (key: unknown) => source.has(unwrap(key)),
    get: map ? (key: unknown) => wrap(map.get(unwrap(key))) : undefined,
    keys: () => values(source.keys(), wrap),
    values: () => values(source.values(), wrap),
    entries: () => entries(source.entries(), wrap),
    forEach: (callback: Visitor, thisArg?: unknown) => {
      source.forEach((value, key) => callback.call(thisArg, wrap(value), wrap(key), view));
    },
    [Symbol.iterator]: () => map ? entries(map, wrap) : values(source, wrap)
  };
  // Never expose native methods bound to the source: callbacks and iterators must
  // return the same lazy readonly children, and native mutators must lack a receiver.
  const view: object = new Proxy(Object.create(map ? Map.prototype : Set.prototype), {
    get(_target, property) {
      if (property === 'size') return source.size;
      if (property === Symbol.toStringTag) return map ? 'Map' : 'Set';
      return Object.hasOwn(readers, property) ? Reflect.get(readers, property) : undefined;
    },
    set: denyMutation, defineProperty: denyMutation, deleteProperty: denyMutation,
    setPrototypeOf: denyMutation, preventExtensions: denyMutation
  });
  return view;
}
