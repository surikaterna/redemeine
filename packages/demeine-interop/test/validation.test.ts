import { createAggregate } from '@redemeine/aggregate';
import { Contract, ContractError, type Event } from '@redemeine/kernel';
import { z } from 'zod';
import { createDemeineBridge } from '../src';

test('built contract validates before domain handling, directly and through legacy sink without Mirage', async () => {
  const contract = new Contract();
  contract.addCommand('counter.add.command', z.strictObject({ amount: z.number().int().positive() }));
  const observed = jest.fn();
  const built = createAggregate('counter', { count: 0 })
    .events({ added: (state, event: Event<{ amount: number }>) => { state.count += event.payload.amount; } })
    .commands(emit => ({ add: (_state, payload: { amount: number }) => { observed(payload); return emit.added(payload); } }))
    .contract(contract)
    .build();
  const invalid = { type: 'counter.add.command', payload: { amount: 1.5 } };
  expect(() => built.process(built.initialState, invalid)).toThrow(ContractError);
  expect(observed).not.toHaveBeenCalled();
  const Counter = createDemeineBridge(built);
  const counter = new Counter();
  await expect(counter.add({ amount: 1.5 })).rejects.toThrow(ContractError);
  expect(counter.getVersion()).toBe(0);
  expect(observed).not.toHaveBeenCalled();
  const payload = { amount: 2 };
  await counter.add(payload);
  expect(observed.mock.calls[0]![0]).toBe(payload);
  expect(counter._state.count).toBe(2);
});
