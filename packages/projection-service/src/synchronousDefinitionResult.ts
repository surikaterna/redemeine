function observeNativePromise(value: object): boolean {
  try {
    Promise.prototype.then.call(value, () => {}, () => {});
    return true;
  } catch { return false; }
}

/** Refuse asynchronous work without awaiting it or committing its partial draft. */
export function synchronousDefinitionResult(value: unknown): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (observeNativePromise(value)) throw new Error('unsupported_definition_async_result');
  let then: unknown;
  try { then = Reflect.get(value, 'then'); }
  catch { throw new Error('unsupported_definition_async_result'); }
  if (typeof then !== 'function') return value;
  // Capture the getter once; assimilation is observed but cannot delay the refusal.
  void new Promise<unknown>((resolve, reject) => {
    queueMicrotask(() => {
      try { Reflect.apply(then, value, [resolve, reject]); }
      catch (error) { reject(error); }
    });
  }).catch(() => {});
  throw new Error('unsupported_definition_async_result');
}
