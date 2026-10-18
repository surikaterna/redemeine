import { current, isDraft, produce, type Draft } from 'immer';
import type { Command, Event } from '@redemeine/kernel';
import type { EventPlugin, PluginRegistration } from './attachmentTypes';
import { assertSynchronous } from './descriptor';
import { createEnvelopeRuntime } from './envelopeRuntime';
import { envelopeSnapshot } from './envelopeData';
import { stateContextSnapshot } from './stateContextSnapshot';

type Host = {
  aggregateType: string;
  initialState: unknown;
  applyToDraft: (state: never, event: Event) => void;
  process: (state: never, command: Command<unknown, string>) => Event[];
  plugins?: readonly unknown[];
  mounts?: Record<string, unknown>;
  types?: { events: Record<string, string> };
  pure?: { eventProjectors: Record<string, unknown> };
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
    validateSourceEvents(host, plugin);
    keys.add(plugin.id);
  }
}

function validateSourceEvents(host: Host, plugin: EventPlugin): void {
  if (!plugin.source) return;
  const source = plugin.source as Host;
  for (const key of Object.keys(plugin.events)) {
    if (!plugin.events[key]) continue;
    const projector = source.pure?.eventProjectors[key];
    // Without runtime payload schemas, only unchanged projectors prove an inherited contract.
    if (!projector || projector !== host.pure?.eventProjectors[key]) {
      throw new Error(`Incompatible aggregate plugin event contract: ${plugin.id}.${key}; bind the plugin to the host`);
    }
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
    const state = Reflect.get(draft, plugin.id);
    const matched = tables[index]?.get(event.type);
    if (matched) {
      const context = stateContextSnapshot({ aggregateType: host.aggregateType, state: current(draft) });
      assertSynchronous(matched(state, envelopeSnapshot(event), context));
    }
    if (plugin.onEvent) {
      const after = stateContextSnapshot({ aggregateType: host.aggregateType, state: current(draft) });
      assertSynchronous((plugin.onEvent as Handler)(state, envelopeSnapshot(event), after));
    }
  }
}

function application(host: Host, record: Attachment) {
  const tables = record.plugins.map(plugin => routes(host, plugin));
  return (draft: object, event: Event): void => {
    validatePluginState(record.plugins, draft);
    record.domain.applyToDraft(draft as never, event);
    applyPlugins(host, record.plugins, tables, draft, event);
  };
}

function validatePluginState(plugins: readonly EventPlugin[], state: unknown): void {
  for (const plugin of plugins) {
    if (state === null || typeof state !== 'object' || !Object.hasOwn(state, plugin.id)) {
      throw new Error(`Missing aggregate plugin namespace: ${plugin.id}; migrate the snapshot explicitly`);
    }
  }
}

function initializePlugin(plugin: EventPlugin): object {
  const state = plugin.initialize();
  assertSynchronous(state);
  if (state === null || typeof state !== 'object') {
    throw new TypeError(`Aggregate plugin ${plugin.id} initializer must return a non-null object`);
  }
  return state;
}

export function decorateAggregate<A extends Host>(host: A, registrations: readonly PluginRegistration[] = []): A {
  const previous = attachments.get(host) ?? { domain: host, lineage: new Set<object>([host]), plugins: [] };
  const added = registrations.filter((plugin): plugin is EventPlugin => 'kind' in plugin && plugin.kind === 'aggregate-event');
  validate(host, previous, added);
  const initialState = added.length ? produce(host.initialState as object, draft => {
    for (const plugin of added) {
      Reflect.set(draft, plugin.id, initializePlugin(plugin));
    }
  }) : host.initialState;
  const record = { ...previous, lineage: new Set(previous.lineage), plugins: [...previous.plugins, ...added] };
  const applyToDraft = application(host, record);
  const envelopes = createEnvelopeRuntime(host, record.plugins);
  const result = {
    ...host, initialState,
    plugins: [...host.plugins ?? [], ...registrations.filter(plugin => !('kind' in plugin && plugin.kind === 'aggregate-event'))],
    aggregatePlugins: Object.freeze(record.plugins),
    prepareCommand: envelopes.prepareCommand,
    process: envelopes.active ? (state: object, raw: Command<unknown, string>) => {
      const command = envelopes.prepareCommand(state, raw);
      const events = record.domain.process(state as never, command);
      const prepared = events.map(event => envelopes.prepareEvent(state, command, event));
      const intents = Object.getOwnPropertyDescriptor(events, '__intents');
      if (intents) Object.defineProperty(prepared, '__intents', intents);
      return prepared;
    } : record.domain.process,
    validateState: (state: unknown) => validatePluginState(record.plugins, state),
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
