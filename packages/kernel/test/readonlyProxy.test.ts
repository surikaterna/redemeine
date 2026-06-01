import { describe, it, expect } from 'vitest';
import { createReadonlyDeepProxy } from '../src/utils/readonlyProxy';

describe('createReadonlyDeepProxy', () => {
  it('returns primitives as-is', () => {
    expect(createReadonlyDeepProxy(42)).toBe(42);
    expect(createReadonlyDeepProxy('hello')).toBe('hello');
    expect(createReadonlyDeepProxy(null)).toBe(null);
    expect(createReadonlyDeepProxy(undefined)).toBe(undefined);
  });

  it('allows reading properties', () => {
    const obj = createReadonlyDeepProxy({ a: 1, b: { c: 2 } });
    expect(obj.a).toBe(1);
    expect(obj.b.c).toBe(2);
  });

  it('throws on property set', () => {
    const obj = createReadonlyDeepProxy({ x: 1 });
    expect(() => { (obj as any).x = 2; }).toThrow('Cannot mutate');
  });

  it('throws on property delete', () => {
    const obj = createReadonlyDeepProxy({ x: 1 });
    expect(() => { delete (obj as any).x; }).toThrow('Cannot mutate');
  });

  it('throws on defineProperty', () => {
    const obj = createReadonlyDeepProxy({ x: 1 });
    expect(() => Object.defineProperty(obj, 'y', { value: 2 })).toThrow('Cannot mutate');
  });

  it('deeply protects nested objects', () => {
    const obj = createReadonlyDeepProxy({ nested: { deep: { val: 'ok' } } });
    expect(obj.nested.deep.val).toBe('ok');
    expect(() => { (obj.nested.deep as any).val = 'bad'; }).toThrow('Cannot mutate');
  });

  it('caches proxies for same object', () => {
    const original = { a: 1 };
    const p1 = createReadonlyDeepProxy(original);
    const p2 = createReadonlyDeepProxy(original);
    expect(p1).toBe(p2);
  });
});
