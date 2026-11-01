import type { ProjectionDefinition, ProjectionHandler, ProjectionDeduplicationStrategy, ProjectionHooks } from '@redemeine/projection-runtime-core';
import { normalizeLiveRegistration } from '@redemeine/projection-transport';
import { synchronousDefinitionResult } from './synchronousDefinitionResult';

type Callable = (...args: unknown[]) => unknown;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) throw new Error('invalid_definition_shape');
  return value;
}
function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) throw new Error('unsupported_definition_field');
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(value)) throw new Error('invalid_definition_name');
  return value;
}
function callable(value: unknown): Callable {
  if (typeof value !== 'function') throw new Error('invalid_definition_callable');
  return (...args) => synchronousDefinitionResult(Reflect.apply(value, undefined, args));
}
function functions(value: unknown): Record<string, Callable> {
  const values = record(value); const keys = Object.getOwnPropertyNames(values);
  if (keys.length > 256) throw new Error('definition_handler_capacity');
  return Object.fromEntries(keys.map((key) => [name(key), callable(values[key])]));
}
function empty(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 0) throw new Error('unsupported_definition_routing');
}
function deduplication(value: unknown): ProjectionDeduplicationStrategy {
  const data = record(value); closed(data, ['strategy', 'warnings']);
  if (data.strategy !== 'in_document' && data.strategy !== 'own_record') throw new Error('unsupported_definition_dedupe');
  if (data.warnings === undefined) return Object.freeze({ strategy: data.strategy });
  const warnings = record(data.warnings); closed(warnings, ['warnAtSourceCount', 'warnAtMetadataBytes']);
  const copy: { warnAtSourceCount?: number; warnAtMetadataBytes?: number } = {};
  for (const key of ['warnAtSourceCount', 'warnAtMetadataBytes']) {
    const value = warnings[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1000000000)) throw new Error('invalid_definition_warning');
  }
  if (typeof warnings.warnAtSourceCount === 'number') copy.warnAtSourceCount = warnings.warnAtSourceCount;
  if (typeof warnings.warnAtMetadataBytes === 'number') copy.warnAtMetadataBytes = warnings.warnAtMetadataBytes;
  return Object.freeze({ strategy: data.strategy, warnings: Object.freeze(copy) });
}
function hooks(value: unknown): ProjectionHooks<unknown> {
  const data = record(value); closed(data, ['afterEach']);
  if (data.afterEach === undefined) return Object.freeze({});
  const afterEach = callable(data.afterEach);
  return Object.freeze({ afterEach: (state: unknown, event: Parameters<ProjectionDefinition['identity']>[0]) => { afterEach(state, event); } });
}
function definition(value: unknown): ProjectionDefinition<unknown> {
  const data = record(value); closed(data, ['name', 'fromStream', 'initialState', 'identity', 'subscriptions', 'joinStreams', 'reverseSubscribeStreams', 'hooks', 'deduplication']);
  empty(data.subscriptions); if (data.joinStreams !== undefined) empty(data.joinStreams); if (data.reverseSubscribeStreams !== undefined) empty(data.reverseSubscribeStreams);
  const stream = record(data.fromStream); closed(stream, ['aggregate', 'handlers']);
  const aggregate = record(stream.aggregate); const pure = record(aggregate.pure);
  if (!Object.hasOwn(aggregate, 'initialState')) throw new Error('invalid_aggregate_descriptor');
  const rawHandlers = functions(stream.handlers); if (Object.keys(rawHandlers).length === 0) throw new Error('empty_definition_handlers');
  const handlers: Record<string, ProjectionHandler<unknown>> = Object.fromEntries(Object.entries(rawHandlers).map(([key, handler]) =>
    [key, (state: unknown, event: Parameters<ProjectionDefinition['identity']>[0], context: unknown) => { handler(state, event, context); }]));
  const initial = callable(data.initialState); const identity = callable(data.identity);
  return Object.freeze({ name: name(data.name), subscriptions: [],
    initialState: (id: string) => initial(id), identity: (event: Parameters<ProjectionDefinition['identity']>[0]) => {
      const target = identity(event); if (Array.isArray(target) && target.length === 0) return [];
      if (typeof target !== 'string' || target.length === 0 || target.length > 512) throw new Error('unsupported_definition_identity');
      return target;
    }, fromStream: Object.freeze({ aggregate: Object.freeze({ aggregateType: name(aggregate.aggregateType), initialState: aggregate.initialState,
      pure: Object.freeze({ eventProjectors: Object.freeze(functions(pure.eventProjectors)) }) }), handlers: Object.freeze(handlers) }),
    ...(data.hooks === undefined ? {} : { hooks: hooks(data.hooks) }), ...(data.deduplication === undefined ? {} : { deduplication: deduplication(data.deduplication) }) });
}

export function validateRegistrations(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error('invalid_registration_count');
  const names = new Set<string>();
  return Object.freeze(value.map((entry: unknown) => {
    const data = record(entry); closed(data, ['definition', 'initialization', 'routing']);
    if (data.initialization !== 'suffix_contributions' || data.routing !== 'event_stable_commutative') throw new Error('unsupported_registration_profile');
    const snapshot = definition(data.definition); if (names.has(snapshot.name)) throw new Error('duplicate_definition_name'); names.add(snapshot.name);
    Object.freeze(snapshot.subscriptions);
    return normalizeLiveRegistration({ definition: snapshot, initialization: 'suffix_contributions', routing: 'event_stable_commutative' });
  }));
}
