import { createAggregate, createAggregatePlugin } from '../src';
import { cloneEnvelopeData } from '../src/plugins/envelopeData';

const cases = [
  ['object split', () => ({ x: 1 }), true],
  ['object collapse', () => ({ x: 1 }), false],
  ['Date split', () => new Date(123), true],
  ['Date collapse', () => new Date(123), false]
] as const;

test.each(cases)('%s revalidates cached and reconstructed commands identically', (_name, make, aliased) => {
  const initialize = jest.fn((_input: unknown, context: { command: { payload: unknown } }) => {
    const payload = context.command.payload;
    if (!payload || typeof payload !== 'object' || (Reflect.get(payload, 'a') === Reflect.get(payload, 'b')) !== aliased) {
      throw new TypeError('Invalid payload aliases');
    }
    return { checked: true };
  });
  const plugin = createAggregatePlugin('audit').state(() => ({})).commandEnvelope(initialize).build();
  const host = createAggregate('host', {}).build().withPlugins(plugin);
  const a = make();
  const prepared = host.prepareCommand(host.initialState, { type: 'check', payload: { a, b: aliased ? a : make() } });
  expect(host.prepareCommand(host.initialState, prepared)).toBe(prepared);
  expect(initialize).toHaveBeenCalledTimes(1);
  prepared.payload.b = aliased ? make() : prepared.payload.a;
  expect(() => host.prepareCommand(host.initialState, prepared)).toThrow('Invalid payload aliases');
  expect(initialize).toHaveBeenCalledTimes(2);
  const reconstructed = cloneEnvelopeData(prepared);
  expect(() => host.prepareCommand(host.initialState, reconstructed)).toThrow('Invalid payload aliases');
  expect(initialize).toHaveBeenCalledTimes(3);
});

test('matching cyclic and sparse payload graphs remain cache hits', () => {
  const initialize = jest.fn(() => ({ checked: true }));
  const host = createAggregate('host', {}).build().withPlugins(
    createAggregatePlugin('audit').state(() => ({})).commandEnvelope(initialize).build()
  );
  const payload: { self?: unknown; items: unknown[] } = { items: new Array(3) };
  payload.self = payload;
  payload.items[1] = payload;
  const prepared = host.prepareCommand(host.initialState, { type: 'check', payload });
  expect(host.prepareCommand(host.initialState, prepared)).toBe(prepared);
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(prepared.payload.self).toBe(prepared.payload);
  expect(prepared.payload.items[1]).toBe(prepared.payload);
  expect(0 in prepared.payload.items).toBe(false);
});
