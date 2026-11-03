import type { NamingStrategy } from '@redemeine/kernel';
import type { EntityMountOverrides } from '../types/entityMount';

type MountedName = {
  member: string;
  segments: readonly string[];
  override?: { value: string; prefixCount: number | null };
};

// Naming belongs to a registration, not a reusable handler or semantic path.
const names = new WeakMap<object, Map<string, MountedName>>();

export function semanticSegment(name: string, options?: EntityMountOverrides): string {
  const segment = options?.semanticName === undefined ? name : options.semanticName;
  if (typeof segment !== 'string' || !segment.trim() || segment.includes('.')) {
    throw new TypeError('Entity semanticName must be one nonempty, nondotted segment');
  }
  return segment;
}

export function copyMountedName(destination: object, key: string, source: object, sourceKey: string): void {
  const map = names.get(destination) ?? new Map<string, MountedName>();
  const incoming = names.get(source)?.get(sourceKey);
  if (incoming) map.set(key, incoming);
  else map.delete(key);
  names.set(destination, map);
}

export function mountName(destination: object, key: string, source: object, sourceKey: string,
  segment: string, relative?: string, full?: string): void {
  const incoming = names.get(source)?.get(sourceKey) ?? { member: sourceKey, segments: [] };
  let override = relative === undefined ? incoming.override : { value: relative, prefixCount: 0 };
  if (override && override.prefixCount !== null) override = { ...override, prefixCount: override.prefixCount + 1 };
  if (full !== undefined) override = { value: full, prefixCount: null };
  const map = names.get(destination) ?? new Map<string, MountedName>();
  map.set(key, { member: incoming.member, segments: [segment, ...incoming.segments], ...(override ? { override } : {}) });
  names.set(destination, map);
}

export function mountedWire(definitions: object, key: string, aggregate: string,
  strategy: NamingStrategy, kind: 'command' | 'event'): string | undefined {
  const name = names.get(definitions)?.get(key);
  if (!name) return undefined;
  if (!name.override) return strategy[kind](aggregate, name.member, name.segments.join('.'));
  const { value, prefixCount } = name.override;
  if (prefixCount === null) return value;
  const suffix = value.endsWith(`.${kind}`) ? value : `${value}.${kind}`;
  return [aggregate, ...name.segments.slice(0, prefixCount), suffix].join('.');
}
