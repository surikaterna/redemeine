import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Contract, ContractError, StateIntegrityError } from '../src/Contract';

describe('Contract', () => {
  function createTestContract() {
    return new Contract()
      .addCommand('createUser', z.object({ name: z.string(), email: z.string().email() }))
      .addEvent('userCreated', z.object({ id: z.string(), name: z.string() }));
  }

  describe('addCommand / addEvent', () => {
    it('stores and retrieves command schemas', () => {
      const contract = createTestContract();
      expect(contract.getCommand('createUser')).toBeDefined();
    });

    it('stores and retrieves event schemas', () => {
      const contract = createTestContract();
      expect(contract.getEvent('userCreated')).toBeDefined();
    });

    it('returns undefined for unknown command type', () => {
      const contract = createTestContract();
      expect(contract.getCommand('nonexistent')).toBeUndefined();
    });

    it('returns undefined for unknown event type', () => {
      const contract = createTestContract();
      expect(contract.getEvent('nonexistent')).toBeUndefined();
    });
  });

  describe('validateCommand', () => {
    it('returns parsed data for valid input', () => {
      const contract = createTestContract();
      const result = contract.validateCommand('createUser', { name: 'Alice', email: 'a@b.com' });
      expect(result).toEqual({ name: 'Alice', email: 'a@b.com' });
    });

    it('throws ContractError for invalid data', () => {
      const contract = createTestContract();
      expect(() => contract.validateCommand('createUser', { name: 123 }))
        .toThrow(ContractError);
    });

    it('throws ContractError for unknown command type', () => {
      const contract = createTestContract();
      expect(() => contract.validateCommand('unknown', {}))
        .toThrow('Command schema not found');
    });
  });

  describe('validateEvent', () => {
    it('returns parsed data for valid input', () => {
      const contract = createTestContract();
      const result = contract.validateEvent('userCreated', { id: '1', name: 'Alice' });
      expect(result).toEqual({ id: '1', name: 'Alice' });
    });

    it('throws ContractError for invalid data', () => {
      const contract = createTestContract();
      expect(() => contract.validateEvent('userCreated', { id: 123 }))
        .toThrow(ContractError);
    });
  });

  describe('validateState', () => {
    it('passes through data when no state schema set', () => {
      const contract = new Contract();
      const data = { anything: true };
      expect(contract.validateState(data)).toBe(data);
    });

    it('validates against state schema', () => {
      const contract = new Contract().setStateSchema(z.object({ count: z.number() }));
      expect(contract.validateState({ count: 5 })).toEqual({ count: 5 });
    });

    it('throws StateIntegrityError for invalid state', () => {
      const contract = new Contract().setStateSchema(z.object({ count: z.number() }));
      expect(() => contract.validateState({ count: 'bad' }))
        .toThrow(StateIntegrityError);
    });
  });

  describe('ReadonlyMap accessors', () => {
    it('commands getter exposes map with correct size', () => {
      const contract = createTestContract();
      expect(contract.commands.size).toBe(1);
      expect(contract.commands.has('createUser')).toBe(true);
    });

    it('events getter exposes map with correct size', () => {
      const contract = createTestContract();
      expect(contract.events.size).toBe(1);
      expect(contract.events.has('userCreated')).toBe(true);
    });
  });

  describe('fromZodExports', () => {
    it('builds contract from export object', () => {
      const contract = Contract.fromZodExports({
        Commands: { CreateUserSchema: z.object({ name: z.string() }) },
        Events: { UserCreated: z.object({ id: z.string() }) },
        State: z.object({ users: z.array(z.string()) }),
      });
      expect(contract.getCommand('createUser')).toBeDefined();
      expect(contract.getEvent('userCreated')).toBeDefined();
      expect(contract.stateSchema).toBeDefined();
    });

    it('ignores non-zod values', () => {
      const contract = Contract.fromZodExports({
        Commands: { NotASchema: 'hello' },
      });
      expect(contract.commands.size).toBe(0);
    });
  });
});
