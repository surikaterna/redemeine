import { commandMetadata, createAggregate, createEntity } from '../src';

const template = { id: '' };
function staticRow() {
  return createEntity('row', template).commands(() => ({ register: () => [], ordinary: () => [] }), { static: ['register'] }).build();
}

test('compiled static classification is readonly and follows factory replacement', () => {
  const entity = createEntity('row', template)
    .commands(() => ({ register: () => [], retained: () => [] }), { static: ['register', 'retained'] })
    .commands(() => ({ register: () => [], added: () => [] }), { static: ['added'] }).build();
  const host = createAggregate('metadata', { rows: [] as typeof template[] }).entityList('rows', entity).build();
  expect(commandMetadata(host, 'rowsRegister')?.isStatic).toBe(false);
  expect(commandMetadata(host, 'rowsRetained')?.isStatic).toBe(true);
  expect(commandMetadata(host, 'rowsAdded')?.isStatic).toBe(true);
  expect(Reflect.set(commandMetadata(host, 'rowsAdded')!, 'isStatic', false)).toBe(false);
});

test('same-definition remount, supported decoration and rebuild preserve classification; different definitions fail', () => {
  const entity = staticRow();
  const ordinary = createEntity('row', template).commands(() => ({ register: () => [] })).build();
  const builder = createAggregate('mounts', { rows: [] as typeof template[] }).entityList('rows', entity);
  const first = builder.build();
  expect(commandMetadata(first, 'rowsRegister')?.isStatic).toBe(true);
  expect(commandMetadata(first.withPlugins(), 'rowsRegister')?.isStatic).toBe(true);
  const remounted = builder.entityList('rows', entity).build();
  expect(commandMetadata(remounted, 'rowsRegister')?.isStatic).toBe(true);
  expect(() => builder.entityList('rows', ordinary).build()).toThrow(/Conflicting entity definitions.*rows/);
  expect(commandMetadata(first, 'rowsRegister')?.isStatic).toBe(true);
});

test('mount ownership is local to the target chain, not the shared local segment or definition name', () => {
  const left = createEntity('sameName', { id: '' }).commands(() => ({ read: () => [] })).build();
  const right = createEntity('sameName', { id: '' }).commands(() => ({ read: () => [] })).build();
  const parent = (child: typeof left) => createEntity('parent', { id: '' }).entityList('rows', child).build();
  const host = createAggregate('separate', { left: [], right: [] })
    .entityList('left', parent(left)).entityList('right', parent(right)).build();
  expect(commandMetadata(host, 'leftRowsRead')?.targets).toHaveLength(2);
  expect(commandMetadata(host, 'rightRowsRead')?.targets).toHaveLength(2);
  expect(() => createEntity('invalid', { id: '' }).entityList('rows', left).entityList('rows', right).build())
    .toThrow(/Conflicting entity definitions.*rows/);
});

test('nested authored names cannot flatten ambiguously before aggregate compilation', () => {
  const child = createEntity('child', { id: '' }).commands(() => ({ register: () => [], Register: () => [] })).build();
  const parent = createEntity('parent', { id: '' }).entityList('rows', child).build();
  expect(() => createAggregate('invalid', { parents: [] }).entityList('parents', parent).build())
    .toThrow(/rows\.register.*rows\.Register.*rowsRegister/);
});

test('wire winner remains explicit, and nested statics retain their target chain', () => {
  const entity = staticRow();
  const parent = createEntity('parent', { id: '', children: [] as typeof template[] }).entityList('children', entity).build();
  const host = createAggregate('winner', { rows: [] as typeof template[], parents: [] as { id: string; children: typeof template[] }[] })
    .entityList('rows', entity, {}, { commandNameOverrides: { register: 'shared', ordinary: 'shared' } })
    .entityList('parents', parent).build();
  expect(commandMetadata(host, 'rowsRegister')).toMatchObject({ isStatic: true, isWireWinner: false, winnerLocalName: 'rowsOrdinary' });
  expect(commandMetadata(host, 'rowsOrdinary')).toMatchObject({ isStatic: false, isWireWinner: true });
  expect(commandMetadata(host, 'parentsChildrenRegister')?.targets).toHaveLength(2);
});
