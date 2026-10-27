import { createAggregate, createEntity, createMixin } from '../src';

const entity = () => createEntity<{ code: string; qty: number }, 'row'>('row')
  .events({ changed(state, event: { payload: { qty: number } }) { state.qty = event.payload.qty; } })
  .commands(emit => ({ set(state, payload: Record<string, unknown>) {
    return emit.changed({ ...payload, qty: state.qty + 1 });
  } })).build();

test.each(['order_items', 'orderItems'])('ancestor identity uses only exact registered prefix %s', prefix => {
  const parent = createEntity('parent').entityList('children', entity(), { pk: 'code' }).build();
  const host = createAggregate('store', { [prefix]: [{ code: 'p', children: [{ code: 'c', qty: 1 }] }] })
    .entityList(prefix, parent, { pk: 'code' }).build();
  const creator = host.commandCreators[`${prefix}ChildrenSet`]!;
  const payload = { [`${prefix}Code`]: 'p', code: 'c', childrenCode: 'ordinary', __entityPk: { code: 'other' } };
  const event = host.process(host.initialState, creator(payload))[0]!;
  expect(event.payload).toEqual({ ...payload, qty: 2 });
  expect(host.apply(host.initialState, event)[prefix]![0]!.children[0]!.qty).toBe(2);
  for (const alias of ['orderItemCode', 'order_itemCode', 'order_itemsCode', 'orderItemsCode'].filter(key => key !== `${prefix}Code`)) {
    expect(() => host.process(host.initialState, creator({ [alias]: 'p', code: 'c' }))).toThrow('Invalid mounted command target');
    expect(() => host.apply(host.initialState, { ...event, payload: { [alias]: 'p', code: 'c' } })).toThrow('Invalid mounted command target');
  }
});

test.each([{ pk: ['code', 'code'] }, { pk: [] }])('duplicate or empty declared PK rejects without freezing caller array %j', ({ pk }) => {
  expect(() => createAggregate('store', { rows: [] }).entityList('rows', entity(), { pk }).build())
    .toThrow('Invalid mounted command target');
  expect(Object.isFrozen(pk)).toBe(false);
});

test('ancestor and leaf canonical field collision rejects at compilation', () => {
  const parent = createEntity('parent').entityList('children', entity(), { pk: 'parentsCode' }).build();
  expect(() => createAggregate('store', { parents: [] }).entityList('parents', parent, { pk: 'code' }).build())
    .toThrow('Invalid mounted command target');
});

test.each(['__proto__', 'constructor', 'toString'])('own canonical field %s survives single and composite predicates', field => {
  for (const pk of [field, [field, 'region']]) {
    const state = { qty: 99, rows: [{ [field]: 'actual', region: 'west', qty: 1 }] };
    const host = createAggregate('store', state).entityList('rows', entity(), { pk }).build();
    const input = { [field]: 'actual', region: 'west', __entityPk: 'business', id: 'business' };
    const event = host.process(state, host.commandCreators.rowsSet(input))[0]!;
    expect(host.apply(state, event).rows[0]!.qty).toBe(2);
    const draft = structuredClone(state);
    host.applyToDraft(draft, event);
    expect(draft.rows[0]!.qty).toBe(2);
    for (const missing of [{ ...input, [field]: 'MISSING' }, ...(Array.isArray(pk) ? [{ ...input, region: 'MISSING' }] : [])]) {
      expect(() => host.process(state, host.commandCreators.rowsSet(missing))).toThrow('Invalid mounted command target');
      expect(() => host.apply(state, { ...event, payload: missing })).toThrow('Invalid mounted command target');
      expect(() => host.applyToDraft(structuredClone(state), { ...event, payload: missing })).toThrow('Invalid mounted command target');
    }
    expect(state.rows[0]!.qty).toBe(1);
    expect(Object.getPrototypeOf(state.rows[0])).toBe(Object.prototype);
    expect(event.payload).toEqual({ ...input, qty: 2 });
  }
});

test.each(['', [], [''], ['id', 'id'], null, 0, false, {}, ['id', 3]])('all list registration paths reject invalid PK %j without behavior', pk => {
  const row = createEntity('row').build();
  const mount = (builder: object) => Reflect.apply(Reflect.get(builder, 'entityList'), builder, ['rows', row, { pk }]);
  expect(() => mount(createAggregate('store', { rows: [] })).build()).toThrow('Invalid mounted command target');
  expect(() => mount(createEntity('parent')).build()).toThrow('Invalid mounted command target');
  expect(() => mount(createMixin()).build()).toThrow('Invalid mounted command target');
});

test.each(['direct', 'nested', 'mixin', 'flattened', 'inherited'])('late invalid caller PK is checked on %s build even without behavior', kind => {
  const pk = ['id'];
  const row = createEntity('row').build();
  const direct = createAggregate('store', { rows: [] }).entityList('rows', row, { pk });
  const parent = createEntity('parent').entityList('rows', row, { pk });
  const mixin = createMixin().entityList('rows', row, { pk });
  const source = mixin.build();
  const builder = kind === 'nested' ? createAggregate('store', { parents: [] }).entityList('parents', parent.build())
    : kind === 'mixin' ? createAggregate('store', { rows: [] }).mixins(source)
    : kind === 'flattened' ? createAggregate('store', { rows: [] }).mixins({ ...source, mountedEntities: [] })
    : kind === 'inherited' ? createAggregate('store', { rows: [] }).extends(direct) : direct;
  pk.push('id');
  expect(() => builder.build()).toThrow('Invalid mounted command target');
  expect(Object.isFrozen(pk)).toBe(false);
});

test.each([0, ''])('empty and zero PK values remain valid: %j', code => {
  const host = createAggregate('store', { rows: [{ code, qty: 1 }] }).entityList('rows', entity(), { pk: 'code' }).build();
  expect(host.process(host.initialState, host.commandCreators.rowsSet({ code }))).toHaveLength(1);
});
