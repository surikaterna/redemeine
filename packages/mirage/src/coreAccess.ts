import type { MirageCore } from './MirageCore';

const cores = new WeakMap<object, MirageCore<unknown>>();
export function registerCore<S>(instance: object, core: MirageCore<S>): void {
  // The private registry erases S; typed public helpers restore it from the same instance.
  cores.set(instance, core as unknown as MirageCore<unknown>);
}

export function getCore<S = unknown>(instance: unknown): MirageCore<S> {
  if ((typeof instance !== 'object' && typeof instance !== 'function') || instance === null) {
    throw new TypeError('Not a valid Mirage Instance.');
  }
  const core = cores.get(instance);
  if (!core) throw new TypeError('Not a valid Mirage Instance.');
  // S is recovered by the public helper's Mirage signature, never by inspecting domain properties.
  return core as unknown as MirageCore<S>;
}
