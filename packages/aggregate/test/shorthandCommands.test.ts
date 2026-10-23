import { createAggregate } from '../src';

test('only explicit pack combines multiple caller arguments; valid shorthand forwards one value', () => {
  const received: unknown[] = [];
  const host = createAggregate('shorthand', { count: 0 }).commands(() => ({
    zero: () => { received.push(undefined); return []; },
    stateOnly: state => { received.push(state.count); return []; },
    optional: (_state, payload?: { name: string }) => { received.push(payload); return []; },
    packed: {
      pack: (name: string, amount: number) => ({ name, amount }),
      handler: (_state, payload: { name: string; amount: number }) => {
        received.push(payload.name, payload.amount.toFixed());
        return [];
      }
    }
  })).build();
  const payload = { name: 'ok' };
  const commands = [host.commandCreators.zero(), host.commandCreators.stateOnly(),
    host.commandCreators.optional(), host.commandCreators.optional(undefined),
    host.commandCreators.optional(payload), host.commandCreators.packed('ok', 2)];
  expect(commands.map(command => command.payload)).toEqual([undefined, undefined, undefined, undefined, payload, { name: 'ok', amount: 2 }]);
  for (const command of commands) host.process(host.initialState, command);
  expect(received).toEqual([undefined, 0, undefined, undefined, payload, 'ok', '2']);
});

test('untyped unsupported shorthand demonstrates why multi-argument declarations must reject', () => {
  const unsupported = {
    go: (_state: unknown, name: string, amount: number) => ({ type: 'bad', payload: `${name}:${amount.toFixed()}` })
  };
  // @ts-expect-error Regression control: runtime intentionally has no automatic argument packing.
  const host = createAggregate('unsupported', {}).commands(() => unsupported).build();
  const command = Reflect.apply(host.commandCreators.go, undefined, ['name', 2]);
  expect(() => host.process(host.initialState, command)).toThrow(TypeError);
});

test('callables ignore attached pack and handler properties while object commands use them', () => {
  const received: unknown[] = [];
  const pack = jest.fn((name: string, amount: number) => ({ name, amount }));
  const handler = jest.fn(() => []);
  const host = createAggregate('callable', {}).commands(() => ({
    zero: Object.assign(() => { received.push(undefined); return []; }, { pack, handler }),
    one: Object.assign((_state: unknown, payload: number) => { received.push(payload); return []; }, { pack, handler }),
    handlerOnly: Object.assign((_state: unknown, payload: number) => { received.push(payload); return []; }, { handler }),
    packed: { pack, handler }
  })).build();
  const commands = [host.commandCreators.zero(), host.commandCreators.one(7), host.commandCreators.handlerOnly(8)];
  expect(commands.map(command => command.payload)).toEqual([undefined, 7, 8]);
  for (const command of commands) host.process(host.initialState, command);
  expect(received).toEqual([undefined, 7, 8]);
  expect(pack).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  const packed = host.commandCreators.packed('ok', 2);
  expect(packed.payload).toEqual({ name: 'ok', amount: 2 });
  host.process(host.initialState, packed);
  expect(pack).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledTimes(1);
});

test.each(['pack', 'handler'])('unsupported callable ignores its attached %s at runtime', property => {
  const ignored = jest.fn((name: string, amount: number) => ({ name, amount }));
  const go = Object.assign((_state: unknown, name: string, amount: number) => ({ type: 'bad', payload: `${name}:${amount.toFixed()}` }),
    property === 'pack' ? { pack: ignored } : { handler: ignored });
  // @ts-expect-error Runtime control deliberately supplies unsupported two-slot shorthand.
  const host = createAggregate('unsupportedAttached', {}).commands(() => ({ go })).build();
  const command = Reflect.apply(host.commandCreators.go, undefined, ['name', 2]);
  expect(command.payload).toBe('name');
  expect(() => host.process(host.initialState, command)).toThrow(TypeError);
  expect(ignored).not.toHaveBeenCalled();
});
