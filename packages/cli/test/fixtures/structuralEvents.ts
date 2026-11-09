import { createAggregate, createEntity } from '../../../aggregate/src';
import type { Event } from '../../../kernel/src';
import { z } from 'zod';

interface Box<T> { value: T }
type Alias<T> = { value: T };
const leaf = createEntity('leaf', { count: 0 }).events({
    changed: (_state, _event: Event<Box<number>>) => {},
    aliased: (_state, _event: Event<Alias<number>>) => {},
    nested: (_state, _event: Event<Box<Box<number>>>) => {},
}).build();
const parent = createEntity('parent', { count: 0 }).entityMap('children', leaf).build();
export const aggregate = createAggregate('structural', { count: 0 })
    .events({ changed: (_state, _event: Event<Box<number>>) => {} })
    .entityList('items', leaf).entityMap('byKey', leaf).entityList('parents', parent).build();
const schema = z.string().min(3);
type Output = z.infer<typeof schema>;
declare class Base<T = Output> { value: T }
declare class Hidden extends Base {}
declare const hidden: Hidden;
export const opaqueQuery = createAggregate('query', { count: 0 })
    .events({ changed: (_state, _event: Event<Box<typeof hidden>>) => {} }).build();
export const opaqueUtility = createAggregate('utility', { count: 0 })
    .events({ changed: (_state, _event: Event<Box<InstanceType<typeof Hidden>>>) => {} }).build();
throw Error('APPLICATION_EXECUTED');
