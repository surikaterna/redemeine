import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAggregate, createEntity } from '../../aggregate/src';
import { createMirage, extractUncommittedEvents } from '../src';
import { Contract } from '@redemeine/kernel';
import { z } from 'zod';

test.each([{ pk: 'id' }, { pk: 'code' }, { pk: ['domain', 'authority'] }] as const)('injects only canonical fields and preserves authored business data: %j', ({ pk }) => {
  const fields = typeof pk === 'string' ? [pk] : pk;
  const identity = Object.fromEntries(fields.map((field, index) => [field, index ? '' : 0]));
  const received: unknown[] = [];
  const item = createEntity('item').events({ changed() {} }).commands(emit => ({
    set(_state, payload: Record<string, unknown>) { received.push(payload); return emit.changed({ ...payload }); },
    packed: { pack: (...args: unknown[]) => ({ ...Object.fromEntries(fields.map((field, index) => [field, args[index]])), body: args[fields.length] }),
      handler(_state, payload: Record<string, unknown>) { received.push(payload); return emit.changed({ ...payload }); } }
  })).build();
  const host = createAggregate('store', { items: [{ ...identity }] }).entityList('items', item, { pk }).build();
  const hook = jest.fn();
  host.hooks = { onBeforeCommand: hook };
  const live = createMirage(host, 'store');
  const selected = live.items(typeof pk === 'string' ? 0 : identity);
  selected.set({});
  expect(received[0]).toEqual(identity);
  expect(JSON.stringify(extractUncommittedEvents(live)[0]!.payload)).toBe(JSON.stringify(identity));
  selected.packed({ ordinary: true });
  expect(received[1]).toEqual({ ...identity, body: { ordinary: true } });
  const business = { id: 'business', itemsId: 'ordinary', itemCode: false, __entityPk: { code: 'wrong' } };
  const payload = { ...business, ...identity };
  selected.set(payload);
  expect(received[2]).toEqual(payload);
  expect(extractUncommittedEvents(live)[2]!.payload).toEqual(payload);
  expect(hook).toHaveBeenCalledTimes(3);
  expect(() => selected.set({ [fields[0]!]: 'other' })).toThrow(/identity/i);
  expect(hook).toHaveBeenCalledTimes(3);
});

test('production payload routing never reads or generates a private marker', () => {
  for (const file of ['aggregate/src/build/entityCommandTarget.ts', 'mirage/src/proxy/selectedIdentity.ts', 'mirage/src/proxy/deepProxy.ts']) {
    expect(readFileSync(resolve(__dirname, '../../', file), 'utf8')).not.toContain('__entityPk');
  }
});

test.each(['id', 'code', 'key'])('strict canonical %s schema sees no generated extra fields', field => {
  const item = createEntity('item').events({ changed() {} }).commands(emit => ({
    set(_state, payload: Record<string, unknown>) { return emit.changed({ ...payload }); }
  })).build();
  const contract = new Contract();
  contract.addCommand('store.items_set.command', z.strictObject({ [field]: z.string() }));
  const builder = createAggregate('store', { items: field === 'key' ? { a: {} } : [{ [field]: 'a' }] });
  const host = (field === 'key' ? builder.entityMap('items', item) : builder.entityList('items', item, { pk: field }))
    .contract(contract).build();
  const live = createMirage(host, 'store');
  const selected = field === 'key' ? live.items.a : live.items('a');
  selected.set({});
  expect(extractUncommittedEvents(live)[0]!.payload).toEqual({ [field]: 'a' });
});
