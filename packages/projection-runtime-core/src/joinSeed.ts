import type { Draft } from 'immer';
import type { ProjectionEvent } from './types';

type Aggregate = { readonly aggregateType: string };
type NamedView = { readonly name: string; initialState(id: string): unknown };
export type ReadonlySeed<T> = T extends object ? { readonly [K in keyof T]: ReadonlySeed<T[K]> } : T;
type AggregateState<T> = '__stateType' extends keyof T
  ? T extends { readonly __stateType?: infer S } ? S : never
  : T extends { initialState: infer S } ? S : never;

// Structural across the two DSL packages, invariant in both authoring inputs.
export interface JoinSeed<TSource extends Aggregate, TSeed> extends JoinSeedKey {
  readonly sourceAggregateType: TSource['aggregateType'];
  readonly sourceType: (source: TSource) => TSource;
  readonly stateType: (state: TSeed) => TSeed;
}

export interface JoinSeedKey {
  readonly kind: 'join-seed-v1';
  readonly sourceAggregateType: string;
  readonly from: 'snapshot' | 'projection';
  readonly seedName: string;
}

export type JoinSeedBinding = JoinSeedKey & {
  readonly sourceType: (...args: never[]) => unknown;
  readonly stateType: (...args: never[]) => unknown;
};

const bindingBrand = Symbol.for('redemeine.projection.join-initializer.v1');

export function isJoinSeedBinding(value: unknown): value is JoinSeedBinding {
  return typeof value === 'object' && value !== null && Object.isFrozen(value)
    && Object.getOwnPropertyDescriptor(value, bindingBrand)?.value === true;
}

export function joinInitializer<TSource extends Aggregate & { initialState: unknown }>(
  source: TSource, input: { from: 'snapshot' }
): JoinSeed<TSource, AggregateState<TSource>>;
export function joinInitializer<TSource extends Aggregate, TView extends NamedView>(
  source: TSource, input: { from: 'projection'; projection: TView }
): JoinSeed<TSource, ReturnType<TView['initialState']>>;
export function joinInitializer<TSource extends Aggregate>(source: TSource,
  input: { from: 'snapshot' } | { from: 'projection'; projection: NamedView }): JoinSeedKey {
  const seedName = input.from === 'snapshot' ? source.aggregateType : input.projection?.name;
  if (!source.aggregateType?.trim() || !seedName?.trim()
    || (input.from === 'snapshot' ? !('initialState' in source)
      : input.from !== 'projection' || typeof input.projection?.initialState !== 'function')) {
    throw new Error('joinInitializer requires a named aggregate and, for projection seeds, a built named view.');
  }
  const binding = { kind: 'join-seed-v1' as const, sourceAggregateType: source.aggregateType, from: input.from, seedName,
    sourceType: (value: TSource) => value, stateType: (value: unknown) => value };
  return Object.freeze(Object.defineProperty(binding, bindingBrand, { value: true }));
}

export type JoinSeedPosition =
  | { readonly kind: 'throughCommit'; readonly streamId: string; readonly commitSequence: number }
  | { readonly kind: 'unknown' };

export type JoinSeedEventCoverage = 'covered' | 'uncovered' | 'unknown' | 'differentSource';

export interface JoinSeedProvenance {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly from: JoinSeedKey['from'];
  readonly seedName: string;
  readonly seedGeneration: string;
  readonly documentId: string;
  readonly position: JoinSeedPosition;
}

export interface JoinSeedInitializeInfo {
  readonly targetDocumentId: string;
  readonly event: ReadonlySeed<ProjectionEvent>;
  readonly coverage: JoinSeedEventCoverage;
  readonly provenance: JoinSeedProvenance;
}

export type JoinSeedInitializer<TState, TSeed> = (
  draft: Draft<TState>, seed: ReadonlySeed<TSeed>, info: JoinSeedInitializeInfo
) => undefined;

export interface JoinSeedRegistration<TState> {
  readonly binding: JoinSeedKey;
  readonly initialize: (draft: Draft<TState>, seed: unknown, info: JoinSeedInitializeInfo) => undefined;
}

export function registerJoinInitializer<TState, TSource extends Aggregate, TSeed>(
  registrations: JoinSeedRegistration<TState>[], binding: JoinSeed<TSource, TSeed>,
  initialize: JoinSeedInitializer<TState, NoInfer<TSeed>>
): void {
  if (!isJoinSeedBinding(binding) || typeof initialize !== 'function'
    || registrations.some(({ binding: existing }) => existing.sourceAggregateType === binding.sourceAggregateType)) {
    throw new Error('.onJoinInitialize() requires one immutable named seed binding per joined aggregate.');
  }
  registrations.push(Object.freeze({ binding, initialize: initialize as JoinSeedRegistration<TState>['initialize'] }));
}

export function validateJoinInitializers(
  registrations: readonly { binding: JoinSeedKey }[], fromType: string,
  joins: readonly { aggregate: Aggregate }[], deduplication?: { strategy: string }
): void {
  if (deduplication?.strategy !== 'own_record') throw new Error('.onJoinInitialize() requires own_record deduplication.');
  const seen = new Set<string>();
  for (const { binding } of registrations) {
    if (binding.sourceAggregateType === fromType || seen.has(binding.sourceAggregateType)
      || joins.filter(({ aggregate }) => aggregate.aggregateType === binding.sourceAggregateType).length !== 1) {
      throw new Error('.onJoinInitialize() requires one matching .join() per named seed binding.');
    }
    seen.add(binding.sourceAggregateType);
  }
}
