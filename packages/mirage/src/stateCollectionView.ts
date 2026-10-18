type Wrap = (value: unknown) => unknown;
type Visitor = (value: unknown, key: unknown, collection: object) => void;
type Kind = 'Map' | 'Set';
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
const mapMethods: Map<unknown, unknown> = Map.prototype;
const setMethods: Set<unknown> = Set.prototype;

export function collectionKind(value: object): Kind | undefined {
  // structuredClone can return foreign-realm collections in embedded runtimes.
  try { mapSize.call(value); return 'Map'; } catch { /* Try the other native brand. */ }
  try { setSize.call(value); return 'Set'; } catch { return undefined; }
}

function denyMutation(): never {
  throw new TypeError('Cannot mutate readonly collection');
}

function* values(source: Iterable<unknown>, wrap: Wrap): IterableIterator<unknown> {
  for (const value of source) yield wrap(value);
}

function* entries(source: Iterable<[unknown, unknown]>, wrap: Wrap): IterableIterator<[unknown, unknown]> {
  for (const [key, value] of source) yield [wrap(key), wrap(value)];
}

export function collectionView(source: object, kind: Kind, wrap: Wrap, unwrap: Wrap): object {
  const prototype = kind === 'Map' ? mapMethods : setMethods;
  const iterator = () => kind === 'Map'
    ? entries(mapMethods.entries.call(source), wrap) : values(setMethods.values.call(source), wrap);
  // Computed collections can store views themselves, distinct from pristine keys.
  const memberKey = (key: unknown) => prototype.has.call(source, key) ? key : unwrap(key);
  const readers = {
    has: (key: unknown) => prototype.has.call(source, memberKey(key)),
    get: kind === 'Map' ? (key: unknown) => wrap(mapMethods.get.call(source, memberKey(key))) : undefined,
    keys: () => values(prototype.keys.call(source), wrap),
    values: () => values(prototype.values.call(source), wrap),
    entries: () => entries(prototype.entries.call(source), wrap),
    forEach: (callback: Visitor, thisArg?: unknown) => {
      prototype.forEach.call(source, (value: unknown, key: unknown) => callback.call(thisArg, wrap(value), wrap(key), view));
    },
    [Symbol.iterator]: iterator
  };
  // The facade has no native slots: reflective/prototype calls cannot recover data.
  const view: object = new Proxy(Object.create(prototype), {
    get(_target, key) {
      if (key === 'size') return (kind === 'Map' ? mapSize : setSize).call(source);
      if (key === Symbol.toStringTag) return kind;
      return Object.hasOwn(readers, key) ? Reflect.get(readers, key) : undefined;
    },
    set: denyMutation, defineProperty: denyMutation, deleteProperty: denyMutation,
    setPrototypeOf: denyMutation, preventExtensions: denyMutation
  });
  return view;
}
