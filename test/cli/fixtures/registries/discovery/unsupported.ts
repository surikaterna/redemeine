import { createAggregate } from '../../../../../packages/aggregate/src';
import { createProjection, type ProjectionDefinition } from '../../../../../packages/projection/src';
import type { Event } from '../../../../../packages/kernel/src';
import { account } from './mixed';

export const badState = createAggregate('bad-state', { callback: () => 1 }).build();
export const badCommand = createAggregate('bad-command', {})
  .commands(() => ({ tuple: (_state, value: [string, number]) => [] as Event[] })).build();
export const badEvent = createAggregate('bad-event', {})
  .events({ invalid: (_state, _event: Event<undefined>) => {} }).build();
export const badProjection = createProjection('bad', () => ({ tuple: ['x', 1] as [string, number] })).from(account, {}).build();
export const erased = createProjection('erased', () => 1).from(account, {}).build() as unknown;
export const malformed = {} as Omit<ProjectionDefinition<number>, 'identity'> & { identity: number };
declare function unresolved(): ProjectionDefinition<number> | undefined;
export const ambiguous = unresolved();
export const copy = { ...account };
export const separate = createAggregate('account', { distinct: true }).build();
export let mutableAlias = account;
export const mutableSnapshot = mutableAlias;
export const opaque = (() => ({ ...account }))();
export const renamed = { ...account, aggregateType: 'renamed' as const };
