import { createAggregate } from '@redemeine/aggregate';
import { createDemeineBridge } from '../src';

test('generated shorthand arity preserves existing no-payload normalization and explicit packing', async () => {
  const received: unknown[] = [];
  const built = createAggregate('shorthand', { count: 0 }).commands(() => ({
    zero: () => { received.push('zero'); return []; },
    stateOnly: state => { received.push(state.count); return []; },
    optional: (_state, payload?: { name: string }) => { received.push(payload); return []; },
    required: (_state, payload: { name: string }) => { received.push(payload); return []; },
    packed: {
      pack: (name: string, amount: number) => ({ name, amount }),
      handler: (_state: unknown, payload: { name: string; amount: number }) => {
        received.push(payload.name, payload.amount.toFixed());
        return [];
      }
    }
  })).build();
  const live = new (createDemeineBridge(built))();
  const payload = { name: 'ok' };
  await live.zero();
  await live.stateOnly();
  await live.optional();
  await live.optional(undefined);
  await live.optional(payload);
  await live.required(payload);
  await live.packed('ok', 2);
  expect(received).toEqual(['zero', 0, {}, {}, payload, payload, 'ok', '2']);
  expect(built.commandCreators.optional().payload).toBeUndefined();
});
