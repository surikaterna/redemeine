import { describe, expect, test } from '@jest/globals';
import { z } from 'zod';
import { Contract, ContractError, StateIntegrityError } from '../src/Contract';

describe('Contract', () => {
  test('registers and validates commands/events/state', () => {
    const contract = new Contract()
      .addCommand('order.create.command', z.object({ id: z.string() }))
      .addEvent('order.created.event', z.object({ id: z.string() }))
      .setStateSchema(z.object({ id: z.string(), count: z.number() }));

    expect(contract.getCommand('order.create.command')).toBeDefined();
    expect(contract.getEvent('order.created.event')).toBeDefined();

    expect(contract.validateCommand('order.create.command', { id: 'o1' })).toEqual({ id: 'o1' });
    expect(contract.validateEvent('order.created.event', { id: 'o1' })).toEqual({ id: 'o1' });
    expect(contract.validateState({ id: 'o1', count: 1 })).toEqual({ id: 'o1', count: 1 });
  });

  test('throws ContractError for missing or invalid command/event schema', () => {
    const contract = new Contract()
      .addCommand('order.create.command', z.object({ id: z.string() }))
      .addEvent('order.created.event', z.object({ id: z.string() }));

    expect(() => contract.validateCommand('missing.command', {})).toThrow(ContractError);
    expect(() => contract.validateCommand('order.create.command', { id: 1 })).toThrow(ContractError);

    expect(() => contract.validateEvent('missing.event', {})).toThrow(ContractError);
    expect(() => contract.validateEvent('order.created.event', { id: 1 })).toThrow(ContractError);
  });

  test('throws StateIntegrityError for invalid state shape', () => {
    const contract = new Contract().setStateSchema(z.object({ id: z.string(), count: z.number() }));
    expect(() => contract.validateState({ id: 'o1', count: 'nope' })).toThrow(StateIntegrityError);
  });

  test('creates contract from Zod export object', () => {
    const exportsObj = {
      Commands: {
        CreateOrderSchema: z.object({ id: z.string() })
      },
      Events: {
        OrderCreatedSchema: z.object({ id: z.string() })
      },
      State: z.object({ id: z.string() })
    };

    const contract = Contract.fromZodExports(exportsObj);

    expect(contract.getCommand('createOrder')).toBeDefined();
    expect(contract.getEvent('orderCreated')).toBeDefined();
    expect(contract.validateState({ id: 'ok' })).toEqual({ id: 'ok' });
  });
});
