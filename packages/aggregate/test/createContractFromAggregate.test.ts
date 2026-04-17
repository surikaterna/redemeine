import { createAggregate } from '@redemeine/aggregate';
import { Event, Contract } from '@redemeine/kernel';
import { createContractFromAggregate } from '../src/createContractFromAggregate';
import { z } from 'zod';

describe('createContractFromAggregate', () => {
  const initialState = { id: '', status: 'pending' };

  const aggregate = createAggregate<typeof initialState, 'order'>('order', initialState)
    .events({
      created: (state, event: Event<{ id: string }>) => { state.id = event.payload.id; },
      cancelled: (state) => { state.status = 'cancelled'; }
    })
    .commands((emit) => ({
      create: (state, payload: { id: string }) => emit.created(payload),
      cancel: (state) => emit.cancelled()
    }))
    .build();

  it('should wire command schemas to resolved type strings', () => {
    const contract = createContractFromAggregate(aggregate, {
      commands: {
        create: z.object({ id: z.string() }),
        cancel: z.object({})
      }
    });

    expect(contract.commands.size).toBe(2);
    expect(contract.commands.has('order.create.command')).toBe(true);
    expect(contract.commands.has('order.cancel.command')).toBe(true);
  });

  it('should wire event schemas to resolved type strings', () => {
    const contract = createContractFromAggregate(aggregate, {
      events: {
        created: z.object({ id: z.string() }),
        cancelled: z.object({})
      }
    });

    expect(contract.events.size).toBe(2);
    expect(contract.events.has('order.created.event')).toBe(true);
    expect(contract.events.has('order.cancelled.event')).toBe(true);
  });

  it('should set state schema when provided', () => {
    const stateSchema = z.object({ id: z.string(), status: z.string() });
    const contract = createContractFromAggregate(aggregate, {
      state: stateSchema
    });

    expect(contract.stateSchema).toBe(stateSchema);
  });

  it('should validate commands using resolved type strings', () => {
    const contract = createContractFromAggregate(aggregate, {
      commands: {
        create: z.object({ id: z.string() })
      }
    });

    expect(() => contract.validateCommand('order.create.command', { id: 'abc' })).not.toThrow();
    expect(() => contract.validateCommand('order.create.command', { id: 123 })).toThrow();
  });

  it('should skip schemas for keys not found in aggregate types', () => {
    const contract = createContractFromAggregate(aggregate, {
      commands: {
        create: z.object({ id: z.string() }),
        nonExistent: z.object({})
      }
    });

    expect(contract.commands.size).toBe(1);
    expect(contract.commands.has('order.create.command')).toBe(true);
  });

  it('should return a Contract instance', () => {
    const contract = createContractFromAggregate(aggregate, {});
    expect(contract).toBeInstanceOf(Contract);
  });
});
