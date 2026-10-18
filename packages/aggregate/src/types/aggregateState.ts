/** Public state is a borrowed readonly view, not a cloned or universally frozen value. */
export type AggregateStateView<T> = T extends (...args: never[]) => unknown ? T
  : T extends Date ? Readonly<Pick<Date, Exclude<keyof Date, `set${string}`>>>
  : T extends ReadonlyMap<infer K, infer V> ? ReadonlyMap<AggregateStateView<K>, AggregateStateView<V>>
  : T extends ReadonlySet<infer V> ? ReadonlySet<AggregateStateView<V>>
  : T extends object ? { readonly [K in keyof T]: AggregateStateView<T[K]> }
  : T;

/** Preserve the model before readonly views erase capabilities such as Date setters. */
export type AggregateStateModel<A> = A extends unknown
  ? '__stateType' extends keyof A
    ? A extends { readonly __stateType?: infer S } ? S : never
    : A extends { initialState: infer S } ? S : never
  : never;
