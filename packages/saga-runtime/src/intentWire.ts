import { createHash } from 'node:crypto';
import type { SagaPluginIntent } from '@redemeine/saga';
import { encodeCanonicalIdentityPreimage } from './identity/canonicalEncoding';
import { type SagaCanonicalCorrelation, serializeSagaCorrelation } from './identity/canonicalCorrelation';
import { deriveSagaInstanceId } from './identity/deterministicIds';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface WireOrigin {
  readonly sagaKey: string;
  readonly correlation: SagaCanonicalCorrelation;
  readonly sourceId: string;
  readonly routeId: string;
  readonly ordinal: number;
}
export interface WireMetadata { readonly sagaId: string; readonly correlationId: string; readonly causationId: string }
export interface WireRouting { readonly response_handler_key: string; readonly error_handler_key: string; readonly retry_handler_key?: string; readonly handler_data: JsonValue }
interface WireBase { readonly schemaVersion: 1; readonly intentId: string; readonly turnId: string; readonly instanceId: string; readonly origin: WireOrigin; readonly metadata: WireMetadata }
export type WireIntent = WireBase & (
  | { readonly kind: 'plugin'; readonly plugin_key: string; readonly action_name: string; readonly interaction: 'fire_and_forget'; readonly execution_payload: JsonValue; readonly retry_policy_override?: JsonValue; readonly compensation?: JsonValue }
  | { readonly kind: 'plugin'; readonly plugin_key: string; readonly action_name: string; readonly interaction: 'request_response'; readonly execution_payload: JsonValue; readonly routing_metadata: WireRouting; readonly retry_policy_override?: JsonValue; readonly compensation?: JsonValue }
  | { readonly kind: 'dispatch'; readonly command: string; readonly aggregateId?: string; readonly payload: JsonValue }
  | { readonly kind: 'schedule'; readonly timerId: string; readonly dueAt: string }
  | { readonly kind: 'cancelSchedule'; readonly timerId: string }
);
export type WireOutcome = {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly instanceId: string;
  readonly correlationId: string;
  readonly result: 'response' | 'error';
  readonly token: string;
  readonly handler_data: JsonValue;
  readonly value: JsonValue;
};
export interface WireRegistryEntry { readonly plugin_key: string; readonly actions: readonly { readonly name: string; readonly interaction: 'fire_and_forget' | 'request_response' }[]; readonly commandTypes?: readonly string[] }

const MAX_BYTES = 65536;
const MAX_DEPTH = 16;
function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > 4096) throw new TypeError(`invalid ${name}`);
  return value;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`invalid ${name}`);
  return Object.fromEntries(Object.entries(value));
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new TypeError('unknown wire field');
}
function json(value: unknown, depth = 0, seen = new Set<object>()): JsonValue {
  if (depth > MAX_DEPTH) throw new RangeError('wire depth exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== 'object') throw new TypeError('non-JSON value');
  if (seen.has(value)) throw new TypeError('cyclic value');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => json(item, depth + 1, seen));
    const source = object(value, 'JSON object');
    return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, json(item, depth + 1, seen)]));
  } finally { seen.delete(value); }
}
function bounded(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_BYTES) throw new RangeError('wire size exceeded');
}
function identity(origin: WireOrigin): Pick<WireBase, 'instanceId' | 'turnId' | 'intentId'> {
  const instanceId = deriveSagaInstanceId(requireText(origin.sagaKey, 'sagaKey'), origin.correlation);
  const parts = [instanceId, requireText(origin.sourceId, 'sourceId'), requireText(origin.routeId, 'routeId')];
  if (!Number.isSafeInteger(origin.ordinal) || origin.ordinal < 0) throw new TypeError('invalid ordinal');
  const hash = (domain: string, values: readonly string[]) => createHash('sha256').update(encodeCanonicalIdentityPreimage(domain, values)).digest('base64url');
  const turnId = `saga_w_${hash('saga.wire.turn.v1', parts)}`;
  return { instanceId, turnId, intentId: `saga_n_${hash('saga.wire.intent.v1', [turnId, origin.ordinal.toString()])}` };
}
function metadata(value: unknown): WireMetadata {
  const v = object(value, 'metadata');
  exact(v, ['sagaId', 'correlationId', 'causationId']);
  return { sagaId: requireText(v.sagaId, 'sagaId'), correlationId: requireText(v.correlationId, 'correlationId'), causationId: requireText(v.causationId, 'causationId') };
}
function originValue(value: unknown): WireOrigin {
  const v = object(value, 'origin');
  exact(v, ['sagaKey', 'correlation', 'sourceId', 'routeId', 'ordinal']);
  const correlation = object(v.correlation, 'correlation');
  exact(correlation, ['type', 'value']);
  const normalized: SagaCanonicalCorrelation = correlation.type === 'string'
    ? { type: 'string', value: requireText(correlation.value, 'correlation') }
    : correlation.type === 'number' && typeof correlation.value === 'number'
      ? { type: 'number', value: correlation.value }
      : (() => { throw new TypeError('invalid correlation'); })();
  serializeSagaCorrelation(normalized);
  if (typeof v.ordinal !== 'number') throw new TypeError('invalid ordinal');
  return { sagaKey: requireText(v.sagaKey, 'sagaKey'), correlation: normalized, sourceId: requireText(v.sourceId, 'sourceId'), routeId: requireText(v.routeId, 'routeId'), ordinal: v.ordinal };
}
function routing(value: unknown): WireRouting {
  const v = object(value, 'routing');
  exact(v, ['response_handler_key', 'error_handler_key', 'retry_handler_key', 'handler_data']);
  return { response_handler_key: requireText(v.response_handler_key, 'response token'), error_handler_key: requireText(v.error_handler_key, 'error token'), handler_data: json(v.handler_data), ...(v.retry_handler_key === undefined ? {} : { retry_handler_key: requireText(v.retry_handler_key, 'retry token') }) };
}
function registered(registry: readonly WireRegistryEntry[], plugin: string, action: string, interaction: string): void {
  if (registry.flatMap(entry => entry.actions.filter(item => entry.plugin_key === plugin && item.name === action && item.interaction === interaction)).length !== 1) throw new TypeError('unknown or ambiguous action');
}
type IntentBody = WireIntent extends infer T ? T extends WireBase ? Omit<T, keyof WireBase> : never : never;
function plugin(v: Record<string, unknown>, registry: readonly WireRegistryEntry[]): IntentBody {
  exact(v, ['kind', 'plugin_key', 'action_name', 'interaction', 'execution_payload', 'routing_metadata', 'retry_policy_override', 'compensation']);
  const plugin_key = requireText(v.plugin_key, 'plugin');
  const action_name = requireText(v.action_name, 'action');
  const interaction = v.interaction;
  registered(registry, plugin_key, action_name, String(interaction));
  const common: { kind: 'plugin'; plugin_key: string; action_name: string; execution_payload: JsonValue; retry_policy_override?: JsonValue; compensation?: JsonValue } = { kind: 'plugin', plugin_key, action_name, execution_payload: json(v.execution_payload),
    ...(v.retry_policy_override === undefined ? {} : { retry_policy_override: json(v.retry_policy_override) }),
    ...(v.compensation === undefined ? {} : { compensation: json(v.compensation) }) };
  if (interaction === 'request_response') return { ...common, interaction, routing_metadata: routing(v.routing_metadata) };
  if (interaction === 'fire_and_forget' && v.routing_metadata === undefined) return { ...common, interaction };
  throw new TypeError('invalid interaction routing');
}

function body(v: Record<string, unknown>, registry: readonly WireRegistryEntry[]): IntentBody {
  if (v.kind === 'plugin') return plugin(v, registry);
  if (v.kind === 'dispatch') {
    exact(v, ['kind', 'command', 'aggregateId', 'payload']);
    const command = requireText(v.command, 'canonical command');
    if (registry.flatMap(entry => entry.commandTypes ?? []).filter(name => name === command).length !== 1) throw new TypeError('legacy or unknown canonical command');
    return { kind: 'dispatch', command, payload: json(v.payload), ...(v.aggregateId === undefined ? {} : { aggregateId: requireText(v.aggregateId, 'aggregateId') }) };
  }
  if (v.kind === 'schedule') {
    exact(v, ['kind', 'timerId', 'dueAt']);
    const dueAt = requireText(v.dueAt, 'dueAt');
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(dueAt) || !Number.isFinite(Date.parse(dueAt)) || new Date(dueAt).toISOString() !== dueAt) throw new TypeError('invalid dueAt');
    return { kind: 'schedule', timerId: requireText(v.timerId, 'timerId'), dueAt };
  }
  if (v.kind === 'cancelSchedule') {
    exact(v, ['kind', 'timerId']);
    return { kind: 'cancelSchedule', timerId: requireText(v.timerId, 'timerId') };
  }
  throw new TypeError('unknown intent kind');
}
export function decodeIntent(value: unknown, registry: readonly WireRegistryEntry[]): WireIntent {
  const v = object(value, 'intent');
  if (v.schemaVersion !== 1) throw new TypeError('unsupported wire version');
  const origin = originValue(v.origin);
  const ids = identity(origin);
  if (v.intentId !== ids.intentId || v.turnId !== ids.turnId || v.instanceId !== ids.instanceId) throw new TypeError('intent identity mismatch');
  const meta = metadata(v.metadata);
  if (meta.sagaId !== ids.instanceId || meta.correlationId !== serializeSagaCorrelation(origin.correlation) || meta.causationId !== origin.sourceId) throw new TypeError('metadata identity mismatch');
  const data = Object.fromEntries(Object.entries(v).filter(([key]) => !['schemaVersion', 'origin', 'intentId', 'turnId', 'instanceId', 'metadata'].includes(key)));
  const result: WireIntent = { schemaVersion: 1, ...ids, origin, metadata: meta, ...body(data, registry) };
  bounded(result);
  return result;
}
export function encodeIntent(value: WireIntent, registry: readonly WireRegistryEntry[]): string {
  json(value);
  return JSON.stringify(decodeIntent(value, registry));
}
export function parseIntent(text: string, registry: readonly WireRegistryEntry[]): WireIntent {
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new RangeError('wire size exceeded');
  return decodeIntent(JSON.parse(text), registry);
}
export function normalizePluginIntent(input: SagaPluginIntent, origin: WireOrigin, registry: readonly WireRegistryEntry[], turnClock?: string): WireIntent {
  if (input.plugin_key === 'core') {
    const payload = object(input.execution_payload, 'core payload');
    if (input.action_name === 'dispatch') {
      exact(payload, ['command', 'payload', 'aggregateId']);
      return createWireIntent(origin, input.metadata, { kind: 'dispatch', command: requireText(payload.command, 'command'), payload: json(payload.payload),
        ...(payload.aggregateId === undefined ? {} : { aggregateId: requireText(payload.aggregateId, 'aggregateId') }) }, registry);
    }
    if (input.action_name === 'cancelSchedule') {
      exact(payload, ['id']);
      return createWireIntent(origin, input.metadata, { kind: 'cancelSchedule', timerId: requireText(payload.id, 'timerId') }, registry);
    }
    if (input.action_name === 'schedule') {
      exact(payload, ['id', 'delay']);
      if (typeof payload.delay !== 'number' || !Number.isSafeInteger(payload.delay) || payload.delay < 0 || turnClock === undefined || new Date(turnClock).toISOString() !== turnClock) throw new TypeError('invalid persisted turn clock or delay');
      const dueAt = new Date(Date.parse(turnClock) + payload.delay).toISOString();
      return createWireIntent(origin, input.metadata, { kind: 'schedule', timerId: requireText(payload.id, 'timerId'), dueAt }, registry);
    }
    throw new TypeError('unknown core action');
  }
  const ids = identity(origin);
  return decodeIntent({ schemaVersion: 1, ...ids, origin, kind: 'plugin', plugin_key: input.plugin_key,
    action_name: input.action_name, interaction: input.interaction, execution_payload: input.execution_payload,
    metadata: input.metadata, ...(input.routing_metadata === undefined ? {} : { routing_metadata: input.routing_metadata }),
    ...(input.retry_policy_override === undefined ? {} : { retry_policy_override: input.retry_policy_override }),
    ...(input.compensation === undefined ? {} : { compensation: input.compensation }) }, registry);
}
export function createWireIntent(origin: WireOrigin, meta: WireMetadata, data: IntentBody, registry: readonly WireRegistryEntry[]): WireIntent {
  return decodeIntent({ schemaVersion: 1, ...identity(origin), origin, metadata: meta, ...data }, registry);
}
export function decodeOutcome(value: unknown, intent: WireIntent): WireOutcome {
  const v = object(value, 'outcome');
  exact(v, ['schemaVersion', 'intentId', 'instanceId', 'correlationId', 'result', 'token', 'handler_data', 'value']);
  if (v.schemaVersion !== 1 || v.intentId !== intent.intentId || v.instanceId !== intent.instanceId || v.correlationId !== intent.metadata.correlationId || intent.kind !== 'plugin' || intent.interaction !== 'request_response') throw new TypeError('outcome mismatch');
  if (v.result !== 'response' && v.result !== 'error') throw new TypeError('invalid result');
  const expected = v.result === 'response' ? intent.routing_metadata.response_handler_key : intent.routing_metadata.error_handler_key;
  if (v.token !== expected || JSON.stringify(json(v.handler_data)) !== JSON.stringify(intent.routing_metadata.handler_data)) throw new TypeError('outcome routing mismatch');
  const result: WireOutcome = { schemaVersion: 1, intentId: intent.intentId, instanceId: intent.instanceId, correlationId: intent.metadata.correlationId, result: v.result, token: expected, handler_data: json(v.handler_data), value: json(v.value) };
  bounded(result);
  return result;
}
export function parseOutcome(text: string, intent: WireIntent): WireOutcome {
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new RangeError('wire size exceeded');
  return decodeOutcome(JSON.parse(text), intent);
}
export function validateIntentBatch(intents: readonly WireIntent[], registry: readonly WireRegistryEntry[]): readonly WireIntent[] {
  const seen = new Set<string>();
  return intents.map(intent => {
    const validated = decodeIntent(intent, registry);
    if (seen.has(validated.intentId)) throw new TypeError('duplicate intent ID');
    seen.add(validated.intentId);
    return validated;
  });
}
