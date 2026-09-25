import { createWireIntent, decodeIntent, decodeOutcome, encodeIntent, normalizePluginIntent, parseIntent, parseOutcome, validateIntentBatch, type WireOrigin } from '../src/intentWire';
import { deriveSagaInstanceId } from '../src/identity/deterministicIds';
import { serializeSagaCorrelation } from '../src/identity/canonicalCorrelation';
import type { SagaPluginIntent } from '@redemeine/saga';
import type { WireRegistryEntry } from '../src/intentWire';

const origin: WireOrigin = { sagaKey: 'orders', correlation: { type: 'string', value: 'o1' }, sourceId: 'source-1', routeId: 'route-1', ordinal: 0 };
const meta = { sagaId: deriveSagaInstanceId(origin.sagaKey, origin.correlation), correlationId: serializeSagaCorrelation(origin.correlation), causationId: origin.sourceId };
const registry: readonly WireRegistryEntry[] = [{ plugin_key: 'mailer', commandTypes: ['invoice.pay.command', 'billing.charge.command', 'custom.order.reserve'], actions: [{ name: 'send', interaction: 'fire_and_forget' }, { name: 'ask', interaction: 'request_response' }] }];

describe('private saga wire v1', () => {
  it('normalizes SDK handles without methods, retains metadata and enforces registration', () => {
    const sdk: SagaPluginIntent<'mailer', 'send', { to: string }, 'fire_and_forget'> & { retryPolicy: () => unknown } = { type: 'plugin-intent', plugin_key: 'mailer', action_name: 'send', interaction: 'fire_and_forget', execution_payload: { to: 'a' }, metadata: meta, retryPolicy: () => sdk };
    const wire = normalizePluginIntent(sdk, origin, registry);
    expect(parseIntent(encodeIntent(wire, registry), registry)).toEqual(wire);
    expect(JSON.stringify(wire)).not.toContain('retryPolicy');
    expect(() => normalizePluginIntent({ ...sdk, action_name: 'missing' }, origin, registry)).toThrow();
    expect(() => normalizePluginIntent(sdk, origin, [...registry, registry[0]] )).toThrow();
  });

  it('preserves request routing and correlates out-of-order outcomes by ID', () => {
    const request: Parameters<typeof createWireIntent>[2] = { kind: 'plugin', plugin_key: 'mailer', action_name: 'ask', interaction: 'request_response', execution_payload: { prompt: 'yes' }, routing_metadata: { response_handler_key: 'ok', error_handler_key: 'failed', retry_handler_key: 'again', handler_data: { local: 42 } } };
    const first = createWireIntent(origin, meta, request, registry);
    const second = createWireIntent({ ...origin, ordinal: 1 }, meta, request, registry);
    expect(second.intentId).not.toBe(first.intentId);
    expect(createWireIntent(origin, meta, request, registry).intentId).toBe(first.intentId);
    const outcome = (intentId: string, result: 'response' | 'error', token: string) => ({ schemaVersion: 1, intentId, instanceId: first.instanceId, correlationId: meta.correlationId, result, token, handler_data: { local: 42 }, value: { code: 1 } });
    expect(decodeOutcome(outcome(second.intentId, 'error', 'failed'), second).intentId).toBe(second.intentId);
    expect(parseOutcome(JSON.stringify(outcome(first.intentId, 'response', 'ok')), first).intentId).toBe(first.intentId);
    expect(() => decodeOutcome(outcome(first.intentId, 'response', 'ok'), second)).toThrow();
    expect(() => decodeOutcome({ ...outcome(first.intentId, 'error', 'failed'), handler_data: {} }, first)).toThrow();
    expect(() => createWireIntent(origin, meta, { ...request, routing_metadata: undefined }, registry)).toThrow();
  });

  it('retains canonical default and overridden command names and timers', () => {
    const command = (name: string) => createWireIntent(origin, meta, { kind: 'dispatch', command: name, payload: { amount: 3 }, aggregateId: 'a1' }, registry);
    expect(parseIntent(encodeIntent(command('invoice.pay.command'), registry), registry).command).toBe('invoice.pay.command');
    expect(command('billing.charge.command').intentId).toBe(command('invoice.pay.command').intentId);
    expect(command('billing.charge.command').kind).toBe('dispatch');
    expect(command('billing.charge.command').command).not.toBe(command('invoice.pay.command').command);
    expect(() => command('pay')).toThrow('legacy');
    expect(() => createWireIntent(origin, meta, { kind: 'dispatch', command: 'invoice.pay.command', payload: null }, [...registry, { plugin_key: 'other', actions: [], commandTypes: ['invoice.pay.command'] }])).toThrow();
    expect(normalizePluginIntent({ type: 'plugin-intent', plugin_key: 'core', action_name: 'dispatch', interaction: 'fire_and_forget', execution_payload: { command: 'custom.order.reserve', payload: { id: 'a1' } }, metadata: meta }, origin, registry).kind).toBe('dispatch');
    expect(normalizePluginIntent({ type: 'plugin-intent', plugin_key: 'core', action_name: 'schedule', interaction: 'fire_and_forget', execution_payload: { id: 't1', delay: 1000 }, metadata: meta }, origin, registry, '2026-09-25T01:00:00.000Z')).toMatchObject({ dueAt: '2026-09-25T01:00:01.000Z' });
    const schedule = createWireIntent(origin, meta, { kind: 'schedule', timerId: 't1', dueAt: '2026-09-25T01:00:00.000Z' }, registry);
    const cancel = createWireIntent({ ...origin, ordinal: 1 }, meta, { kind: 'cancelSchedule', timerId: 't1' }, registry);
    expect(parseIntent(encodeIntent(schedule, registry), registry)).toEqual(schedule);
    expect(parseIntent(encodeIntent(cancel, registry), registry)).toEqual(cancel);
    expect(() => createWireIntent(origin, meta, { kind: 'schedule', timerId: 't1', dueAt: 'tomorrow' }, registry)).toThrow();
    expect(() => validateIntentBatch([schedule, schedule], registry)).toThrow('duplicate');
  });

  it('rejects unknown versions, missing provenance, unsafe JSON, depth and size', () => {
    const valid = createWireIntent(origin, meta, { kind: 'dispatch', command: 'invoice.pay.command', payload: null }, registry);
    expect(() => decodeIntent({ ...valid, schemaVersion: 2 }, registry)).toThrow('version');
    expect(() => decodeIntent({ ...valid, origin: { ...origin, sourceId: '' } }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: { bad: undefined } }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: new Date() }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: Number.NaN }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: BigInt(1) }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: Array.from({ length: 18 }).reduce<object>(value => [value], {}) }, registry)).toThrow();
    expect(() => parseIntent('{broken', registry)).toThrow();
    expect(() => parseIntent(' '.repeat(65537), registry)).toThrow('size');
  });
});
