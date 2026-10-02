import { createProjection } from '../../../../packages/projection/src';
import { createProjection as createRuntimeProjection } from '../../../../packages/projection-runtime-core/src';

const source = { aggregateType: 'source', pure: { eventProjectors: {} } };
type Dictionary<T> = Record<string, T>;
export interface AdvancedState {
  id: string;
  optional?: { values: readonly { label: string; active?: boolean }[] };
  tags: string[];
  strings: Dictionary<string>;
  numbers: Dictionary<number>;
  finite: Record<'left' | 'right', boolean>;
  nullable: string | null;
  variant: { kind: 'ok'; value: number } | { kind: 'error'; message: string };
  _business: string;
  'escaped"\\key': number;
  '__business': string;
  '__@business': string;
  date?: Date;
}

export const implicitProjection = createProjection('implicit', (id) => ({ id, count: 0 }))
  .from(source, {}).join(source, {}).build();

export const advancedProjection = createProjection<AdvancedState>('advanced', (id) => ({
  id, tags: [], strings: {}, numbers: {}, finite: { left: true, right: false }, nullable: null,
  variant: { kind: 'ok', value: 0 }, _business: 'yes', 'escaped"\\key': 1, __business: 'safe', '__@business': 'safe'
})).from(source, {}).build();

export const runtimeProjection = createRuntimeProjection('runtime', () => ({ value: 0 })).from(source, {}).build();
export const commitProjection = createProjection('commit', () => ({ value: 0 })).from(source, {})
  .deduplication({ strategy: 'none', reason: 'fixture', duplicateEffects: 'acknowledged' }).buildCommitDefinition();
export const mirrorProjection = createProjection('mirror').mirror({
  ...source, initialState: { mirrored: 'yes' }, applyToDraft: () => {}
}).build();
export const primitiveProjection = createProjection('primitive', () => 1).from(source, {}).build();
export const nullableProjection = createProjection<{ value: number } | null>('nullable', () => null).from(source, {}).build();
export const handlerProjection = createProjection('handlers', () => ({ value: 0 })).from(source, {
  changed: (draft) => Object.assign(draft, { handlerOnly: 'not declared' })
}).build();
export const unbuilt = createProjection('unbuilt', () => ({ value: 0 }));
export { advancedProjection as reexportedProjection };
