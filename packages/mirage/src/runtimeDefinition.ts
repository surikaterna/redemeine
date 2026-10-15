import type { AggregateHooks, Command, Event, RedemeinePlugin } from '@redemeine/kernel';
import type { MountMetadata } from './mirage.types';

/** Existential input shape; concrete builder generics are retained by MirageOf. */
export interface MirageBuilder {
  aggregateType: string;
  initialState: object;
  process: (...args: never[]) => Event[];
  apply: (...args: never[]) => unknown;
  commandCreators: Record<string, (...args: never) => Command<unknown, string>>;
  selectors?: object;
  mounts?: Record<string, MountMetadata>;
}

export interface RuntimeBuilder<S> {
  aggregateType: string;
  initialState: S;
  process(state: S, command: Command<unknown, string>): Event[];
  apply(state: S, event: Event): S;
  prepareCommand?(state: S, command: Command<unknown, string>): Command<unknown, string>;
  aggregatePlugins?: readonly { commandEnvelope?: unknown; eventEnvelope?: unknown }[];
  hooks?: AggregateHooks<S>;
  metadata?: {
    events?: Record<string, { meta?: Record<string, unknown> }>;
    commands?: Record<string, { meta?: Record<string, unknown> }>;
  };
}

export type RuntimeExtensions = { meta: Record<string, unknown>; intents: Record<string, unknown> };
export type RuntimePlugin = RedemeinePlugin<RuntimeExtensions>;

export function erasePlugins(plugins: readonly unknown[]): RuntimePlugin[] {
  for (const plugin of plugins) {
    if (readProperty(plugin, 'kind') === 'aggregate-event') {
      throw new TypeError('Attach aggregate event plugins via Aggregate.plugins(...) or built.withPlugins(...), not host setup.plugins.');
    }
  }
  // Hooks share the builder's metadata/intent contracts; heterogeneous plugin extensions are erased only here.
  return [...plugins] as RuntimePlugin[];
}

export function builderPlugins(builder: object): RuntimePlugin[] {
  if (!('plugins' in builder) || builder.plugins === undefined) return [];
  if (!Array.isArray(builder.plugins)) throw new TypeError('Builder plugins must be an array');
  // Builder/plugin type contracts own hook signatures; key validation also runs in the core.
  return erasePlugins(builder.plugins);
}

export function metadataFor(registry: unknown, eventType: string): Record<string, unknown> | undefined {
  const value = readProperty(readProperty(readProperty(registry, 'events'), eventType), 'meta');
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Plugin metadata must be an object');
  return Object.fromEntries(Object.entries(value));
}

export function readProperty(value: unknown, key: PropertyKey): unknown {
  return value !== null && (typeof value === 'object' || typeof value === 'function') ? Reflect.get(value, key) : undefined;
}

export function invoke(value: unknown, receiver: unknown, args: unknown[]): unknown {
  if (typeof value !== 'function') throw new TypeError('Expected callable aggregate member');
  return Reflect.apply(value, receiver, args);
}
