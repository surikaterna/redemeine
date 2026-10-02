import { createAggregate } from '../../../../../packages/aggregate/src';
import { createProjection, type ProjectionDefinition as CanonicalProjectionDefinition } from '../../../../../packages/projection/src';
import { createProjection as runtimeProjection } from '../../../../../packages/projection-runtime-core/src/createProjection';
import type { Event } from '../../../../../packages/kernel/src';
import { z } from 'zod';

export const account = createAggregate('account', { total: 0 })
  .events({ added: (state, event: Event<number>) => { state.total += event.payload; } })
  .commands((emit) => ({ add: (_state, amount: number) => emit.added(amount) })).build();
export const accountAlias = account;
type UnionState = { kind: 'number'; value: number } | { kind: 'text'; text: string };
export const unionAggregate = createAggregate<UnionState, 'union'>('union', { kind: 'number', value: 0 }).build();
export default account;
export const aggregateBuilder = createAggregate('unbuilt', {});
export const publicView = createProjection('public', (id) => ({ id, active: true })).from(account, {}).build();
export const publicAlias = publicView;
export const runtimeView = runtimeProjection('runtime', () => ({ count: 0 })).from(account, {}).build();
export const publicCommit = createProjection('public-commit', () => ({ labels: [] as string[] }))
  .from(account, {}).deduplication({ strategy: 'own_record' }).buildCommitDefinition();
export const runtimeCommit = runtimeProjection('runtime-commit', () => ({ optional: null as string | null }))
  .from(account, {}).deduplication({ strategy: 'in_document' }).buildCommitDefinition();
export const mirror = createProjection('mirror').mirror(account).build();
export const projectionBuilder = createProjection('builder', () => 1);
export const commitBuilder = createProjection('commit-builder', () => 1).deduplication({ strategy: 'own_record' });
export const runtimeBuilder = runtimeProjection('runtime-builder', () => 1);
export const scalar = 1;
export const schema = z.object({ id: z.string() });
export const helper = () => account;
export const opaqueErased: unknown = (() => account)();
export class Helper {}
export interface Shape { id: string }
export type AccountType = typeof account;
export const nearProjection = { name: 'near', initialState: () => 1, fromStream: { aggregate: account, handlers: {} } };
export const nearAggregate = { aggregateType: 'near', initialState: {}, commandCreators: {}, pure: { eventProjectors: {} } };
export interface ProjectionDefinitionImpostor { name: string; initialState(id: string): number }
export const impostor: ProjectionDefinitionImpostor = { name: 'local', initialState: () => 1 };
export interface ProjectionDefinition {
  name: string; initialState(id: string): number; identity(event: { aggregateId: string }): string;
  fromStream: { aggregate: typeof account; handlers: {} }; subscriptions: [];
}
export const fullImpostor: ProjectionDefinition = {
  name: 'local-full', initialState: (_id) => 1, identity: (event) => event.aggregateId,
  fromStream: { aggregate: account, handlers: {} }, subscriptions: [],
};
export const annotation: CanonicalProjectionDefinition<{ flag: boolean }> = {
  name: 'annotation', initialState: (_id) => ({ flag: true }), identity: (event) => event.aggregateId,
  fromStream: { aggregate: account, handlers: {} }, subscriptions: [],
};
// Structural TypeScript cannot prove runtime construction for a deliberate canonical cast.
export const cast = {} as CanonicalProjectionDefinition<{ cast: string }>;
throw new Error('DISCOVERY SOURCE EXECUTED');
