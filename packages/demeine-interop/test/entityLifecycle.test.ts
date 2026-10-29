import { createAggregate, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge } from '../src';

test('real bridge packed registration and amendment match native decisions and replay', async () => {
  type Identifier = { domain: string; authority: string; identifier: string };
  const template: Identifier = { domain: '', authority: '', identifier: '' };
  const pack = (domain: string, authority: string, identifier: string) => ({ domain, authority, identifier });
  const entity = createEntity('identifier', template).events({
    registered(state, event: Event<Identifier>) { state.identifier = event.payload.identifier; },
    amended(state, event: Event<Identifier>) { state.identifier = event.payload.identifier; }
  }).commands(emit => ({ register: {
    pack, meta: { description: 'Register or amend identifier' },
    handler(state, payload: Identifier, { isNew }) {
      if (!payload.domain) throw new Error('Invalid domain');
      if (isNew) return emit.registered(payload);
      return state.identifier === payload.identifier ? [] : emit.amended(payload);
    }
  } }), { static: ['register'] }).build();
  const host = createAggregate('registry', { identifiers: [] as Identifier[] })
    .entityList('identifiers', entity, { pk: ['domain', 'authority'] }).build();
  const Bridge = createDemeineBridge(host);
  const bridge = new Bridge();
  let native = host.initialState;
  for (const value of ['one', 'one', 'two']) {
    const events = host.process(native, host.commandCreators.identifiersRegister('d', 'a', value));
    for (const event of events) native = host.apply(native, event);
    await bridge.identifiersRegister('d', 'a', value);
    expect(bridge._state).toEqual(native);
  }
  expect(bridge.getVersion()).toBe(2);
  await expect(bridge.identifiersRegister('', 'a', 'bad')).rejects.toThrow('Invalid domain');
  expect(bridge._state).toEqual(native);
  expect(host.initialState.identifiers).toEqual([]);
  expect(template).toEqual({ domain: '', authority: '', identifier: '' });
  expect(Reflect.get(host.pure.commandProcessors.identifiersRegister!, 'pack')).toBe(pack);
});
