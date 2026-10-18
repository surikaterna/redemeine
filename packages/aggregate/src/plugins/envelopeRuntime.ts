import { createIdentity, type Command, type Event } from '@redemeine/kernel';
import { produce } from 'immer';
import type { EventPlugin } from './attachmentTypes';
import { assertSynchronous } from './descriptor';
import { cloneEnvelopeData, envelopeSnapshot, sameEnvelopeData } from './envelopeData';
import type { EnvelopeSlot } from './envelopeDescriptor';

const coreKeys = ['id', 'type', 'payload', 'headers', 'metadata', 'aggregateId', 'aggregateType', 'correlationId', 'causationId', 'address', 'correlation'] as const;
const reserved = new Set<string>([...coreKeys, 'then', 'prototype']);
type Core = Command<unknown, string> & Record<string, unknown>;
type Host = { aggregateType: string };
type Prepared = { snapshot: object; own: Map<EventPlugin, object> };

function assertRouting(input: object): void {
  for (const key of ['aggregateId', 'aggregateType', 'correlationId', 'causationId']) {
    const value: unknown = Reflect.get(input, key);
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`Invalid envelope routing field: ${key}`);
  }
}

function project(input: Command<unknown, string>): Core {
  assertRouting(input);
  const result: Record<string, unknown> = {};
  for (const key of coreKeys) if (Object.hasOwn(input, key)) result[key] = Reflect.get(input, key);
  return cloneEnvelopeData(result) as Core;
}

function extras(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !coreKeys.includes(key as typeof coreKeys[number])));
}

function extension(value: unknown): object {
  assertSynchronous(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Envelope extension must be a plain object');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || reserved.has(key) || key in Object.prototype) throw new TypeError(`Reserved envelope extension key: ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Envelope extensions require enumerable data properties');
  }
  return cloneEnvelopeData(value);
}

function invoke(slot: EnvelopeSlot, input: object, context: () => object): object {
  const initialized = extension(Reflect.apply(slot.initialize, undefined, [envelopeSnapshot(input), context()]));
  const parsed = extension(slot.parser ? slot.parser.parse(initialized) : initialized);
  const prepared = produce(parsed, draft => {
    for (const recipe of slot.recipes) {
      const result = Reflect.apply(recipe, undefined, [draft, context()]);
      assertSynchronous(result);
      if (result !== undefined) throw new TypeError('Envelope recipes must not return replacements');
    }
  });
  const checked = extension(prepared);
  return extension(slot.parser ? slot.parser.parse(checked) : checked);
}

function merge(target: Core, value: object): void {
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(target, key)) throw new TypeError(`Envelope extension collision: ${key}`);
    Object.defineProperty(target, key, { value: Reflect.get(value, key), enumerable: true, writable: true, configurable: true });
  }
}

function assertNamespaces(state: object, plugins: readonly EventPlugin[]): void {
  for (const plugin of plugins) {
    if (!Object.hasOwn(state, plugin.id)) throw new Error(`Missing aggregate plugin namespace: ${plugin.id}; migrate the snapshot explicitly`);
  }
}

function context(host: Host, state: object, plugin: EventPlugin, command: object, event?: object): object {
  return envelopeSnapshot({ aggregateType: host.aggregateType, state, ownState: Reflect.get(state, plugin.id), command, ...(event ? { event } : {}) });
}

function prepareLinkedEvent(host: Host, plugins: readonly EventPlugin[], own: Map<EventPlugin, object> | undefined, state: object, command: Command<unknown, string>, raw: Event): Event {
  const event = project(raw);
  event.correlationId = command.id;
  const aggregateId: unknown = Reflect.get(command, 'aggregateId');
  if (aggregateId !== undefined) {
    event.aggregateId = aggregateId;
    event.aggregateType = Reflect.get(command, 'aggregateType') ?? host.aggregateType;
  }
  for (const plugin of plugins) {
    if (!plugin.eventEnvelope) continue;
    const ownCommand = { ...project(command), ...own?.get(plugin) };
    merge(event, invoke(plugin.eventEnvelope, extras(raw), () => context(host, state, plugin, ownCommand, project(event))));
  }
  return event as Event;
}

export function createEnvelopeRuntime(host: Host, plugins: readonly EventPlugin[]) {
  const cache = new WeakMap<object, Prepared>();
  const active = plugins.some(plugin => plugin.commandEnvelope || plugin.eventEnvelope);
  function prepareCommand(state: object, raw: Command<unknown, string>): Command<unknown, string> {
    assertRouting(raw);
    if (!active) return raw;
    assertNamespaces(state, plugins);
    const previous = cache.get(raw);
    if (previous && sameEnvelopeData(raw, previous.snapshot)) return raw;
    const command = project(raw);
    command.id ||= createIdentity();
    const own = new Map<EventPlugin, object>();
    for (const plugin of plugins) {
      if (!plugin.commandEnvelope) continue;
      const value = invoke(plugin.commandEnvelope, extras(raw), () => context(host, state, plugin, project(command)));
      merge(command, value);
      own.set(plugin, cloneEnvelopeData(value));
    }
    cache.set(command, { snapshot: cloneEnvelopeData(command), own });
    return command;
  }
  function prepareEvent(state: object, command: Command<unknown, string>, raw: Event): Event {
    if (!active) return raw;
    return prepareLinkedEvent(host, plugins, cache.get(command)?.own, state, command, raw);
  }
  return { prepareCommand, prepareEvent, active };
}
