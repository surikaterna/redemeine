import { current, freeze, isDraft, produce, type Draft } from 'immer';
import type { Event } from '@redemeine/kernel';
import type { EventPlugin, PluginRegistration } from './attachmentTypes';
import { assertSynchronous } from './descriptor';

type Host = {
  aggregateType: string;
  initialState: unknown;
  applyToDraft: (state: never, event: Event) => void;
  plugins?: readonly unknown[];
  mounts?: Record<string, unknown>;
  types?: { events: Record<string, string> };
};
type Attachment = { domain: Host; lineage: Set<object>; plugins: readonly EventPlugin[] };
type Handler = (draft: object, event: Event, context: unknown) => unknown;
const attachments = new WeakMap<object, Attachment>();

export function inheritAggregateIdentity(host: object, parents: readonly object[]): void {
  const record = attachments.get(host);
  if (!record) return;
  for (const parent of parents) {
    record.lineage.add(parent);
    for (const ancestor of attachments.get(parent)?.lineage ?? []) record.lineage.add(ancestor);
  }
}

function validate(host: Host, record: Attachment, plugins: readonly EventPlugin[]): void {
  if (plugins.length && (host.initialState === null || typeof host.initialState !== 'object' || Array.isArray(host.initialState))) {
    throw new TypeError('Aggregate event plugins require object aggregate state');
  }
  const keys = new Set(Reflect.ownKeys(Object(host.initialState)));
  for (const plugin of plugins) {
    if (!plugin.id || plugin.id === 'prototype' || plugin.id in Object.prototype || keys.has(plugin.id) || Object.hasOwn(host.mounts ?? {}, plugin.id)) {
      throw new Error(`Aggregate plugin namespace collision: ${plugin.id}`);
    }
    if (plugin.source && !record.lineage.has(plugin.source as object)) throw new Error(`Incompatible aggregate plugin source: ${plugin.id}`);
    keys.add(plugin.id);
  }
}

function routes(host: Host, plugin: EventPlugin): Map<string, Handler> {
  const result = new Map<string, Handler>();
  for (const [key, handler] of Object.entries(plugin.events)) {
    const type = host.types?.events[key] ?? key;
    if (result.has(type)) throw new Error(`Ambiguous aggregate plugin event handler: ${type}`);
    if (handler) result.set(type, handler as Handler);
  }
  return result;
}

function applyPlugins(host: Host, plugins: readonly EventPlugin[], tables: readonly Map<string, Handler>[], draft: object, event: Event): void {
  for (const [index, plugin] of plugins.entries()) {
    const context = Object.freeze({ aggregateType: host.aggregateType, state: freeze(current(draft), true) });
    const state = Reflect.get(draft, plugin.id);
    const matched = tables[index]?.get(event.type);
    if (matched) assertSynchronous(matched(state, event, context));
    if (plugin.onEvent) {
      const after = Object.freeze({ aggregateType: host.aggregateType, state: freeze(current(draft), true) });
      assertSynchronous((plugin.onEvent as Handler)(state, event, after));
    }
  }
}

function application(host: Host, record: Attachment) {
  const tables = record.plugins.map(plugin => routes(host, plugin));
  return (draft: object, event: Event): void => {
    for (const plugin of record.plugins) {
      if (!Object.hasOwn(draft, plugin.id)) throw new Error(`Missing aggregate plugin namespace: ${plugin.id}; migrate the snapshot explicitly`);
    }
    record.domain.applyToDraft(draft as never, event);
    applyPlugins(host, record.plugins, tables, draft, event);
  };
}

export function decorateAggregate<A extends Host>(host: A, registrations: readonly PluginRegistration[] = []): A {
  const previous = attachments.get(host) ?? { domain: host, lineage: new Set<object>([host]), plugins: [] };
  const added = registrations.filter((plugin): plugin is EventPlugin => 'kind' in plugin && plugin.kind === 'aggregate-event');
  validate(host, previous, added);
  const initialState = added.length ? { ...host.initialState as object } : host.initialState;
  for (const plugin of added) {
    const state = plugin.initialize();
    assertSynchronous(state);
    Object.defineProperty(initialState as object, plugin.id, { value: state, enumerable: true, writable: true, configurable: true });
  }
  const record = { ...previous, lineage: new Set(previous.lineage), plugins: [...previous.plugins, ...added] };
  const applyToDraft = application(host, record);
  const result = {
    ...host, initialState,
    plugins: [...host.plugins ?? [], ...registrations.filter(plugin => !('kind' in plugin && plugin.kind === 'aggregate-event'))],
    aggregatePlugins: Object.freeze(record.plugins),
    applyToDraft: (draft: object, event: Event) => {
      if (record.plugins.length && !isDraft(draft)) throw new TypeError('Plugin application requires an Immer draft');
      applyToDraft(draft, event);
    },
    apply: (state: object, event: Event) => produce(state, (draft: Draft<object>) => applyToDraft(draft, event)),
    withPlugins: (...plugins: PluginRegistration[]) => decorateAggregate(result, plugins)
  };
  record.lineage.add(result);
  attachments.set(result, record);
  // The public attachment types replace state-facing methods; domain methods retain their original contracts.
  return result as A;
}
