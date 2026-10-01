import { createAggregate } from '../../../../packages/aggregate/src';
import { createProjection } from '../../../../packages/projection/src';
import type { Event } from '../../../../packages/kernel/src';

export interface Advanced {
  id: string;
  optional?: { values: readonly { label: string; active?: boolean }[] };
  tags: string[];
  strings: Record<string, string>;
  numbers: Record<string, number>;
  finite: Record<'left' | 'right', boolean>;
  nullable: string | null;
  variant: { kind: 'ok'; value: number } | { kind: 'error'; message: string };
  '__@business': string;
  'escaped"\\key': number;
  _business: string;
  date?: Date;
}
const initial: Advanced = {
  id: '', tags: [], strings: {}, numbers: {}, finite: { left: true, right: false }, nullable: null,
  variant: { kind: 'ok', value: 0 }, '__@business': '', 'escaped"\\key': 1, _business: '',
};

export const orders = createAggregate<Advanced, 'orders'>('orders', initial)
  .events({ registered: (state, event: Event<Advanced>) => { Object.assign(state, event.payload); } })
  .commands((emit) => ({ register: (state, payload: Advanced) => emit.registered(payload) })).build();

export const counter = createAggregate('counter', { count: 0 })
  .events({ counted: (state, event: Event<number>) => { state.count = event.payload; } })
  .commands((emit) => ({ count: (state, payload: number) => emit.counted(payload) })).build();

export const view = createProjection<Advanced>('orders', () => initial).from(orders, {}).build();
export const primitive = createProjection('primitive', () => 0).from(counter, {}).build();
export const inferred = createProjection('inferred', (id) => ({ id, total: 0 })).from(counter, {
  counted: (draft) => Object.assign(draft, { handlerOnly: true }),
}).build();
export const dynamic = { ...counter, aggregateType: String('dynamic') };
export const literalProjection = { ...primitive, name: 'literal' as const };
export const unionName = { ...counter, aggregateType: '' as 'first' | 'second' };
export const scalar = createAggregate('scalar', 0).build();
export default orders;

// Compiler-only extraction must never execute this module.
throw new Error('USER SOURCE EXECUTED');
