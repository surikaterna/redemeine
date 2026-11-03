import { createAggregate, createEntity, createMixin } from '@redemeine/aggregate';
import { createMirage } from '@redemeine/mirage';

const row = createEntity('row', { id: '' }).commands(() => ({
  custom: { pack: (id: string, value: number) => ({ id, value }), handler: () => [] },
  touch: () => []
}), { static: ['custom'] }).build();
const state = { rows: [{ id: 'r' }] };
const optional: { semanticName?: 'credential' } = {};
const maybeOptions = undefined as { semanticName: 'credential' } | undefined;
const union: { semanticName: 'left' | 'right' } = { semanticName: 'left' };
const parentState = { id: 'p', rows: [{ id: 'r' }] };
const optionalParent = createEntity('parent', parentState).entityList('rows', row, {}, optional).build();
const unionParent = createEntity('parent', parentState).entityList('rows', row, {}, union).build();
const maybeParent = createEntity('parent', parentState).entityList('rows', row, {}, maybeOptions).build();
const parentHost = createAggregate('parents', { optional: [parentState], union: [parentState], maybe: [parentState] })
  .entityList('optional', optionalParent).entityList('union', unionParent).entityList('maybe', maybeParent).build();
const optionalMixin = createMixin<typeof state>().entityList('rows', row, {}, optional).build();
const unionMixin = createMixin<typeof state>().entityList('rows', row, {}, union).build();
const maybeMixin = createMixin<typeof state>().entityList('rows', row, {}, maybeOptions).build();
const unionName: 'left' | 'right' = 'left' as 'left' | 'right';
const unionRow = createEntity(unionName, { id: '' }).commands(() => ({ custom: () => [] }), { static: ['custom'] }).build();
const wireOptions = undefined as { commandNameOverrides?: Record<string, string> } | undefined;
const undefinedParent = createEntity('parent', parentState).entityList('rows', row, {}, undefined).build();
const wireParent = createEntity('parent', parentState).entityList('rows', row, {}, wireOptions).build();
const defaultParent = createEntity('parent', parentState).entityList('rows', row).build();
const undefinedMixin = createMixin<typeof state>().entityList('rows', row, {}, undefined).build();
const wireMixin = createMixin<typeof state>().entityList('rows', row, {}, wireOptions).build();
const defaultMixin = createMixin<typeof state>().entityList('rows', row).build();

export const guaranteedAliases = {
  aggregateUndefined: createMirage(createAggregate('undefined', state).entityList('rows', row, {}, undefined).build(), 'root'),
  aggregateWire: createMirage(createAggregate('wire', state).entityList('rows', row, {}, wireOptions).build(), 'root'),
  aggregateDefault: createMirage(createAggregate('default', state).entityList('rows', row).build(), 'root'),
  entityUndefined: createMirage(createAggregate('undefinedParent', { parents: [parentState] }).entityList('parents', undefinedParent).build(), 'root').parents('p'),
  entityWire: createMirage(createAggregate('wireParent', { parents: [parentState] }).entityList('parents', wireParent).build(), 'root').parents('p'),
  entityDefault: createMirage(createAggregate('defaultParent', { parents: [parentState] }).entityList('parents', defaultParent).build(), 'root').parents('p'),
  mixinUndefined: createMirage(createAggregate('undefinedMixin', state).mixins(undefinedMixin).build(), 'root'),
  mixinWire: createMirage(createAggregate('wireMixin', state).mixins(wireMixin).build(), 'root'),
  mixinDefault: createMirage(createAggregate('defaultMixin', state).mixins(defaultMixin).build(), 'root')
};

const explicitParent = createEntity('parent', parentState)
  .entityList<'rows', typeof row, 'id'>('rows', row, {}, { semanticName: 'credential' }).build();
const explicitMixin = createMixin<typeof state>()
  .entityList<'rows', typeof row, 'id'>('rows', row, {}, { commandNameOverrides: { custom: 'wire' } }).build();
export const explicitGenericNavigation = {
  aggregate: createMirage(createAggregate('explicit', state)
    .entityList<'rows', typeof row, 'id'>('rows', row, {}, { semanticName: 'credential' }).build(), 'root'),
  entity: createMirage(createAggregate('explicitParent', { parents: [parentState] }).entityList('parents', explicitParent).build(), 'root').parents('p'),
  mixin: createMirage(createAggregate('explicitMixin', state).mixins(explicitMixin).build(), 'root')
};
createAggregate('explicitWire', state).entityList<'rows', typeof row, 'id'>('rows', row, {}, { commandNameOverrides: {} });
createEntity('explicitWire', parentState).entityList<'rows', typeof row, 'id'>('rows', row, {}, { commandNameOverrides: {} });
createMixin<typeof state>().entityList<'rows', typeof row, 'id'>('rows', row, {}, { semanticName: 'credential' });
createAggregate('explicitUndefined', state).entityList<'rows', typeof row, 'id'>('rows', row, {}, undefined);
createEntity('explicitUndefined', parentState).entityList<'rows', typeof row, 'id'>('rows', row, {}, undefined);
createMixin<typeof state>().entityList<'rows', typeof row, 'id'>('rows', row, {}, undefined);

export const uncertainAliases = {
  aggregateOptional: createMirage(createAggregate('optional', state).entityList('rows', row, {}, optional).build(), 'root'),
  maybeOptions: createMirage(createAggregate('maybeOptions', state).entityList('rows', row, {}, maybeOptions).build(), 'root'),
  aggregateUnion: createMirage(createAggregate('union', state).entityList('rows', row, {}, union).build(), 'root'),
  entityOptional: createMirage(parentHost, 'root').optional('p'),
  entityUnion: createMirage(parentHost, 'root').union('p'),
  entityMaybe: createMirage(parentHost, 'root').maybe('p'),
  mixinOptional: createMirage(createAggregate('optionalMixin', state).mixins(optionalMixin).build(), 'root'),
  mixinUnion: createMirage(createAggregate('unionMixin', state).mixins(unionMixin).build(), 'root'),
  mixinMaybe: createMirage(createAggregate('maybeMixin', state).mixins(maybeMixin).build(), 'root'),
  unionName: createMirage(createAggregate('unionName', state).entityList('rows', unionRow).build(), 'root'),
  namedUnion: createMirage(createAggregate('namedUnion', state).entities({ rows: unionRow }).build(), 'root'),
  packagedUnion: createMirage(createAggregate('packagedUnion', { left: state.rows, right: state.rows }).entities({}, unionRow).build(), 'root'),
  wireOnly: createMirage(createAggregate('wireOnly', state).entityList('rows', row, {}, { commandNameOverrides: { custom: 'wire' } }).build(), 'root'),
  exact: createMirage(createAggregate('exact', state).entityList('rows', row, {}, { semanticName: 'credential' }).build(), 'root')
};

// Downstream contracts
for (const live of Object.values(guaranteedAliases)) {
  live.customRow('r', 1);
  live.rows.custom('r', 1);
  live.rows('r').touch();
  // @ts-expect-error Default aliases preserve authored business argument types.
  live.customRow('r', 'bad');
  // @ts-expect-error No semantic override means no override alias.
  live.customCredential('r', 1);
}
for (const live of Object.values(explicitGenericNavigation)) {
  live.rows.custom('r', 1);
  live.rows('r').touch();
  // @ts-expect-error Explicit generic calls retain navigation argument checks.
  live.rows.custom('r', 'bad');
  // @ts-expect-error Explicit generic calls retain selected identity checks.
  live.rows(123);
  // @ts-expect-error Unknown fourth generic cannot guarantee a semantic alias.
  live.customCredential('r', 1);
}
const noOptionalAliases: {
  [K in 'aggregateOptional' | 'entityOptional' | 'mixinOptional' | 'maybeOptions' | 'entityMaybe' | 'mixinMaybe']:
    Extract<'customCredential' | 'customRow', keyof typeof uncertainAliases[K]> extends never ? true : false
} = { aggregateOptional: true, entityOptional: true, mixinOptional: true, maybeOptions: true, entityMaybe: true, mixinMaybe: true };
const noUnionAliases: {
  [K in 'aggregateUnion' | 'entityUnion' | 'mixinUnion' | 'unionName' | 'namedUnion' | 'packagedUnion']:
    Extract<'customLeft' | 'customRight', keyof typeof uncertainAliases[K]> extends never ? true : false
} = { aggregateUnion: true, entityUnion: true, mixinUnion: true, unionName: true, namedUnion: true, packagedUnion: true };
void [noOptionalAliases, noUnionAliases];
for (const live of [uncertainAliases.aggregateOptional, uncertainAliases.entityOptional, uncertainAliases.mixinOptional]) {
  live.rows.custom('r', 1);
  live.rows('r').touch();
  // @ts-expect-error Optional overrides cannot promise the override alias.
  live.customCredential('r', 1);
  // @ts-expect-error Optional overrides cannot promise the default alias either.
  live.customRow('r', 1);
}
for (const live of [uncertainAliases.aggregateUnion, uncertainAliases.entityUnion, uncertainAliases.mixinUnion]) {
  live.rows.custom('r', 1);
  live.rows('r').touch();
  // @ts-expect-error A union override does not guarantee the left alias.
  live.customLeft('r', 1);
  // @ts-expect-error A union override does not guarantee the right alias.
  live.customRight('r', 1);
}
for (const live of [uncertainAliases.unionName, uncertainAliases.namedUnion]) {
  live.rows.custom();
  // @ts-expect-error A union entity name does not guarantee either alias.
  live.customLeft();
  // @ts-expect-error A union entity name does not guarantee either alias.
  live.customRight();
}
uncertainAliases.wireOnly.customRow('r', 1);
uncertainAliases.exact.customCredential('r', 1);
// @ts-expect-error Exact aliases retain their business argument types.
uncertainAliases.exact.customCredential('r', 'bad');
