import { createWireIntent, decodeIntent, decodeOutcome, encodeIntent, normalizePluginIntent, parseIntent, parseOutcome, validateIntentBatch, type WireOrigin } from '../src/intentWire';
import { deriveSagaInstanceId } from '../src/identity/deterministicIds';
import { serializeSagaCorrelation } from '../src/identity/canonicalCorrelation';
import type { SagaPluginIntent } from '@redemeine/saga';
import type { WireRegistryEntry } from '../src/intentWire';
import { createAggregate } from '@redemeine/aggregate';
import { createSagaCommandsFor } from '@redemeine/saga';

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
    expect(() => decodeOutcome({ ...outcome(first.intentId, 'response', 'ok'), schemaVersion: 2 }, first)).toThrow();
    expect(() => parseOutcome(JSON.stringify({ ...outcome(first.intentId, 'response', 'ok'), value: [null, 1] }), first)).not.toThrow();
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
    expect(() => normalizePluginIntent({ type: 'plugin-intent', plugin_key: 'core', action_name: 'dispatch', interaction: 'request_response', execution_payload: { command: 'custom.order.reserve', payload: {} }, routing_metadata: { response_handler_key: 'ok', error_handler_key: 'fail', handler_data: { id: 'a1' } }, metadata: meta }, origin, registry)).toThrow('unsupported core interaction');
    expect(normalizePluginIntent({ type: 'plugin-intent', plugin_key: 'core', action_name: 'schedule', interaction: 'fire_and_forget', execution_payload: { id: 't1', delay: 1000 }, metadata: meta }, origin, registry, '2026-09-25T01:00:00.000Z')).toMatchObject({ dueAt: '2026-09-25T01:00:01.000Z' });
    const sdkTimer: SagaPluginIntent<'core', 'schedule', { id: string; delay: number }, 'fire_and_forget'> = { type: 'plugin-intent', plugin_key: 'core', action_name: 'schedule', interaction: 'fire_and_forget', execution_payload: { id: 't1', delay: Number.MAX_SAFE_INTEGER }, metadata: meta };
    expect(() => normalizePluginIntent(sdkTimer, origin, registry, '2026-09-25T01:00:00.000Z')).toThrow('invalid_timer');
    expect(() => normalizePluginIntent({ ...sdkTimer, execution_payload: { id: 't1', delay: -1 } }, origin, registry, '2026-09-25T01:00:00.000Z')).toThrow('invalid_timer');
    expect(() => normalizePluginIntent(sdkTimer, origin, registry, 'invalid')).toThrow('invalid_timer');
    expect(() => normalizePluginIntent({ ...sdkTimer, execution_payload: { id: 't1', delay: 1 } }, origin, registry, '9999-12-31T23:59:59.999Z')).toThrow('invalid_timer');
    const schedule = createWireIntent(origin, meta, { kind: 'schedule', timerId: 't1', dueAt: '2026-09-25T01:00:00.000Z' }, registry);
    const cancel = createWireIntent({ ...origin, ordinal: 1 }, meta, { kind: 'cancelSchedule', timerId: 't1' }, registry);
    expect(parseIntent(encodeIntent(schedule, registry), registry)).toEqual(schedule);
    expect(parseIntent(encodeIntent(cancel, registry), registry)).toEqual(cancel);
    expect(() => createWireIntent(origin, meta, { kind: 'schedule', timerId: 't1', dueAt: 'tomorrow' }, registry)).toThrow();
    expect(() => validateIntentBatch([schedule, schedule], registry)).toThrow('duplicate');
  });

  it('normalizes creator envelopes from built aggregates with identical local keys', () => {
    const invoice = createAggregate<{ id: string }, 'invoice'>('invoice', { id: 'a1' })
      .commands(() => ({ pay: (_state, id: string) => ({ type: 'ignored', payload: { id } }) })).build();
    const billing = createAggregate<{ id: string }, 'billing'>('billing', { id: 'a1' })
      .commands(() => ({ pay: (_state, id: string) => ({ type: 'ignored', payload: { id } }) }))
      .overrideCommandNames({ pay: 'billing.charge.command' }).build();
    const invoiceIntent = createSagaCommandsFor(invoice, 'a1', meta).pay('a1');
    const billingIntent = createSagaCommandsFor(billing, 'a1', meta).pay('a1');
    const first = normalizePluginIntent(invoiceIntent, origin, registry);
    const second = normalizePluginIntent(billingIntent, { ...origin, ordinal: 1 }, registry);
    expect(first).toMatchObject({ kind: 'dispatch', command: 'invoice.pay.command' });
    expect(second).toMatchObject({ kind: 'dispatch', command: 'billing.charge.command' });
    expect(parseIntent(encodeIntent(first, registry), registry)).toEqual(first);
    expect(parseIntent(encodeIntent(second, registry), registry)).toEqual(second);
  });

  it('rejects unknown versions, missing provenance, unsafe JSON, depth and size', () => {
    const valid = createWireIntent(origin, meta, { kind: 'dispatch', command: 'invoice.pay.command', payload: null }, registry);
    // biome-ignore lint/suspicious/noSparseArray: an actual hole, not undefined, is the unknown-boundary regression.
    const sparse = [, 1];
    expect(() => decodeIntent({ ...valid, schemaVersion: 2 }, registry)).toThrow('version');
    expect(() => decodeIntent({ ...valid, origin: { ...origin, sourceId: '' } }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: { bad: undefined } }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: sparse }, registry)).toThrow('sparse JSON array');
    expect(() => decodeIntent({ ...valid, payload: [undefined, 1] }, registry)).toThrow('non-JSON value');
    expect(() => decodeIntent({ ...valid, payload: { nested: { bad: Number.POSITIVE_INFINITY } } }, registry)).toThrow('non-JSON value');
    expect(() => decodeIntent({ ...valid, payload: { bad: () => 1 } }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: { bad: Symbol('bad') } }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: JSON.parse('{"__proto__":{"polluted":true}}') }, registry)).toThrow('unsafe JSON key');
    expect(() => decodeOutcome({ schemaVersion: 1, intentId: 'x', instanceId: 'x', correlationId: 'x', result: 'response', token: 'x', handler_data: null, value: sparse }, valid)).toThrow('sparse JSON array');
    expect(() => decodeIntent({ ...valid, payload: new Date() }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: Number.NaN }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: BigInt(1) }, registry)).toThrow();
    expect(() => decodeIntent({ ...valid, payload: Array.from({ length: 18 }).reduce<object>(value => [value], {}) }, registry)).toThrow();
    expect(() => parseIntent('{broken', registry)).toThrow();
    expect(() => parseIntent(' '.repeat(65537), registry)).toThrow('size');
  });

  it('charges encoded bytes before reading oversized children or cloning unknown input', () => {
    const valid = createWireIntent(origin, meta, { kind: 'dispatch', command: 'invoice.pay.command', payload: '' }, registry);
    const baseline = JSON.stringify(valid).length;
    const exact = { ...valid, payload: 'x'.repeat(65536 - baseline) };
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(65536);
    expect(decodeIntent(exact, registry)).toMatchObject({ payload: exact.payload });
    expect(() => decodeIntent({ ...exact, payload: `${exact.payload}x` }, registry)).toThrow('wire size exceeded');
    const huge = { ...valid, payload: { large: 'x'.repeat(65536), unread: Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('TRAVERSED_TOO_FAR'); } }) } };
    expect(() => decodeIntent(huge, registry)).toThrow('wire size exceeded');
    const nested = { ...valid, payload: { outer: { large: 'x'.repeat(65536) } } };
    expect(() => decodeIntent(nested, registry)).toThrow('wire size exceeded');
    const unicode = { ...valid, payload: '😀'.repeat(17000) };
    expect(() => decodeIntent(unicode, registry)).toThrow('wire size exceeded');
  });

  it('matches JSON.stringify byte counts at the boundary for escapes and Unicode in values and keys', () => {
    const valid = createWireIntent(origin, meta, { kind: 'dispatch', command: 'invoice.pay.command', payload: null }, registry);
    const samples = ['ASCII', '"\\\b\t\n\f\r\u0000\u001f', '\u2028\u2029', 'é漢', '😀', '\ud800X\udc00'];
    for (const sample of samples) {
      const candidate = { ...valid, payload: { [sample]: sample, pad: '' } };
      const remaining = 65536 - new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
      const exact = { ...candidate, payload: { [sample]: sample, pad: 'x'.repeat(remaining) } };
      expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(65536);
      expect(decodeIntent(exact, registry)).toMatchObject({ payload: exact.payload });
      expect(() => decodeIntent({ ...exact, payload: { [sample]: sample, pad: `${exact.payload.pad}x` } }, registry)).toThrow('wire size exceeded');
    }
  });

  it('rejects giant leaf and key without encoding them or touching a following getter', () => {
    const valid = createWireIntent(origin, meta, { kind: 'dispatch', command: 'invoice.pay.command', payload: null }, registry);
    const giant = 'a'.repeat(1_200_000);
    const stringify = JSON.stringify;
    const encode = TextEncoder.prototype.encode;
    const jsonSpy = jest.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      if (typeof value === 'string' && value.length > 65536) throw new Error('ENCODED_GIANT');
      return stringify(value);
    });
    const encodeSpy = jest.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (value?: string) {
      if (value !== undefined && value.length > 65536) throw new Error('ENCODED_GIANT');
      return encode.call(this, value);
    });
    try {
      for (const payload of [giant, { [giant]: 1 }]) {
        let touched = false;
        const candidate = Object.defineProperty({ ...valid, payload }, 'poison', { enumerable: true, get() { touched = true; throw new Error('READ_POISON'); } });
        expect(() => decodeIntent(candidate, registry)).toThrow('wire size exceeded');
        expect(touched).toBe(false);
      }
    } finally { jsonSpy.mockRestore(); encodeSpy.mockRestore(); }
  });
});
