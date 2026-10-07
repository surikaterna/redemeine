import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { Aggregate } from 'demeine';
import { createDemeineBridge } from '../src';

export function definition() {
  return createAggregate('counter', { count: 0, items: [] as string[] })
    .events({
      added: (state, event: Event<{ amount: number }>) => { state.count += event.payload.amount; },
    })
    .commands(emit => ({
      add: {
        handler: (_state: unknown, payload: { amount: number }) => ({
          ...emit.added(payload), metadata: { sibling: 'kept', command: { id: 'old', type: 'old.command' } },
        }),
        pack: (amount: number) => ({ amount }),
      },
    }))
    .build();
}

export function fixture() {
  const built = definition();
  const process = jest.spyOn(built, 'process');
  const apply = jest.spyOn(built, 'apply');
  const Bridge = createDemeineBridge(built, { AggregateBase: Aggregate });
  return { built, process, apply, Bridge };
}
