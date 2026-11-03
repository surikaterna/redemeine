import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { createAggregate, createEntity, createMixin, schemaBindings } from '../src';
import type { Event } from '../../kernel/src';

const leaf = () => createEntity('semanticLeaf', { id: '', value: 0 }).events({
  registered: { meta: { owner: 'leaf' }, projector: (state, event: Event<{ value: number }>) => { state.value = event.payload.value; } }
}).commands(emit => ({ register: { pack: (value: number) => ({ value, key: 'one' }),
  handler: (_state, payload: { value: number }) => [emit.registered(payload)] } })).build();

test('bindings retain declaration paths through lists, maps, inherited and mixin mounts', () => {
  const row = leaf();
  const parent = createEntity('semanticParent', { id: '' }).entityMap('children', row).build();
  const deep = createEntity('semanticDeep', { id: '' }).entityList('children', parent).build();
  const base = createAggregate('base', {}).entityList('inherited', row);
  const mixin = createMixin<{}>().entityMap('mixed', row).build();
  const built = createAggregate('host', {}).extends(base).mixins(mixin)
    .entityList('items', row).entityMap('byKey', row).entityList('parents', parent).entityMap('deep', deep).build();
  const bindings = schemaBindings(built);
  expect(Object.keys(bindings.events.schemaToWire).sort()).toEqual([
    'byKey.registered', 'deep.children.children.registered', 'inherited.registered', 'items.registered',
    'mixed.registered', 'parents.children.registered'
  ]);
  expect(bindings.commands.schemaToWire.parentsChildrenRegister.wireType).toBe(built.commandCreators.parentsChildrenRegister({ value: 2 }).type);
  expect(bindings.events.schemaToWire['parents.children.registered'].wireType).toBe('host.semanticParent.semanticLeaf.registered.event');
});

test('actual custom naming and relative/full overrides are compiled once, not guessed by the accessor', () => {
  let calls = 0;
  const row = leaf();
  const parent = createEntity('parent', {}).entityMap('nested', row, {}, {
    eventNameOverrides: { registered: 'relative' }
  }).build();
  const built = createAggregate('host', {}).entityMap('rows', row, {}, { semanticName: 'alias' })
    .entityMap('parents', parent).entityList('full', row, {}, { eventNameOverrides: { registered: 'absolute.event' } })
    .naming({ event: (_aggregate, member, scope) => { calls++; return `custom/${scope}/${member}`; } }).build();
  const before = calls;
  const bindings = schemaBindings(built);
  expect(calls).toBe(before);
  expect(bindings.events.schemaToWire['rows.registered'].wireType).toBe('custom/alias/registered');
  expect(bindings.events.schemaToWire['parents.nested.registered'].wireType).toBe('relative');
  expect(bindings.events.schemaToWire['full.registered'].wireType).toBe('absolute.event');
  const event = built.process({ rows: { one: { id: '', value: 0 } } }, built.commandCreators.rowsRegister(3))[0]!;
  expect(event.type).toBe(bindings.events.schemaToWire['rows.registered'].wireType);
});

test.each([false, true])('forward aliases survive shared wires while reverse follows actual last mount: %s', reverse => {
  const row = leaf();
  let builder = createAggregate('host', {}).events({ root: (_state, _event: Event<{ root: true }>) => {} })
    .overrideEventNames({ root: 'shared.event' }).commands(() => ({ first: () => [], last: () => [] }))
    .overrideCommandNames({ first: 'shared.command', last: 'shared.command' });
  for (const name of reverse ? ['right', 'left'] : ['left', 'right']) {
    builder = builder.entityMap(name, row, {}, { eventNameOverrides: { registered: 'shared.event' } }) as typeof builder;
  }
  const built = builder.build();
  const bindings = schemaBindings(built);
  const winner = reverse ? 'left.registered' : 'right.registered';
  expect(bindings.events.wireToSchema['shared.event']).toBe(winner);
  for (const id of ['root', 'left.registered', 'right.registered']) {
    expect(bindings.events.schemaToWire[id]).toEqual({ wireType: 'shared.event', winnerSchemaId: winner, isWireWinner: id === winner });
  }
  expect(bindings.commands.schemaToWire.first).toEqual({ wireType: 'shared.command', winnerSchemaId: 'last', isWireWinner: false });
  expect(built.metadata.events['shared.event']).toEqual({ meta: { owner: 'leaf' } });
});

test('reused root projectors retain authored keys and the winning undefined metadata', () => {
  const projector = jest.fn();
  const built = createAggregate('host', {}).events(Object.fromEntries([
    ['normal', { projector, meta: { owner: 'old' } }], ['__proto__', projector], ['constructor', projector]
  ])).naming({ event: () => '__proto__' }).build();
  const bindings = schemaBindings(built);
  expect(Object.keys(bindings.events.schemaToWire)).toEqual(['normal', '__proto__', 'constructor']);
  expect(Object.getOwnPropertyDescriptor(bindings.events.wireToSchema, '__proto__')!.value).toBe('constructor');
  expect(bindings.events.schemaToWire.normal.winnerSchemaId).toBe('constructor');
  expect(Object.getOwnPropertyDescriptor(built.metadata.events, '__proto__')!.value).toEqual({});
  built.apply({}, { type: '__proto__', payload: {} });
  expect(projector).toHaveBeenCalledTimes(1);
});

test('nested entity-relative overrides keep the compiled prefix, full overrides stay absolute', () => {
  const row = createEntity('leaf', {}).events({ changed: () => {} })
    .overrideEventNames({ changed: 'relative' }).build();
  const parent = createEntity('parent', {}).entityMap('children', row).build();
  const built = createAggregate('host', {}).entityMap('parents', parent).build();
  expect(schemaBindings(built).events.schemaToWire['parents.children.changed'].wireType).toBe('host.parent.leaf.relative.event');
});

test('namespace collisions and repeated mounts fail only at access, without altering dispatch', () => {
  const row = leaf();
  const collision = createAggregate('host', {}).events({ 'rows.registered': () => {} }).entityMap('rows', row).build();
  expect(() => schemaBindings(collision)).toThrow(/Ambiguous.*rows.registered/);
  const repeated = createAggregate('host', {}).entityMap('rows', row)
    .entityMap('rows', row, {}, { eventNameOverrides: { registered: 'other.event' } }).build();
  expect(() => schemaBindings(repeated)).toThrow(/Ambiguous.*rows.registered/);
  expect(() => repeated.apply({ rows: { a: { id: '', value: 0 } } }, { type: 'other.event', payload: { key: 'a', value: 3 } })).not.toThrow();
  const identical = createAggregate('host', {}).entityMap('rows', row).entityMap('rows', row).build();
  expect(Object.keys(schemaBindings(identical).events.schemaToWire)).toEqual(['rows.registered']);
});

test('all direct mixin events fail closed, including identical handlers and no root collision', () => {
  const projector = () => {};
  const mixin = createMixin<{}>().events({ changed: projector }).build();
  for (const built of [createAggregate('host', {}).mixins(mixin).build(),
    createAggregate('host', {}).events({ changed: projector }).mixins(mixin).build()]) {
    expect(() => schemaBindings(built)).toThrow(/Unsupported direct mixin.*changed/);
    expect(() => built.apply({}, { type: 'host.changed.event', payload: {} })).not.toThrow();
  }
});

test('JSON-safe snapshots are frozen, prototype-safe, detached and preserved by decoration', () => {
  const definition = { pack: (value: number) => ({ value }), handler: () => [] };
  const builder = createAggregate('host', {}).commands(() => Object.fromEntries([
    ['__proto__', definition], ['constructor', () => []]
  ])).overrideCommandNames({ __proto__: 'safe.command', constructor: '__proto__' });
  const built = builder.build();
  const snapshot = schemaBindings(built);
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  const freezeCheck = (value: object) => {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) if (child && typeof child === 'object') freezeCheck(child);
  };
  freezeCheck(snapshot);
  expect(Object.hasOwn(snapshot.commands.schemaToWire, '__proto__')).toBe(true);
  expect(Object.hasOwn(snapshot.commands.wireToSchema, '__proto__')).toBe(true);
  definition.pack = () => ({ value: 99 });
  builder.commands(() => ({ later: () => [] })).build();
  expect(schemaBindings(built)).toBe(snapshot);
  expect(schemaBindings(built.withPlugins())).toBe(snapshot);
  expect(() => schemaBindings({ ...built })).toThrow(/registered built aggregate/);
  expect(() => schemaBindings({})).toThrow(/registered built aggregate/);
});

test('fresh public ESM/CJS exports share carriers and supported decorations across entrypoints', () => {
  const esm = pathToFileURL(path.resolve(__dirname, '../dist/index.js')).href;
  const cjs = pathToFileURL(path.resolve(__dirname, '../dist/index.cjs')).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const a = await import(${JSON.stringify(esm)}); const b = await import(${JSON.stringify(cjs)});
    for (const [build, query] of [[a, b], [b, a]]) {
      const built = build.createAggregate('host', {}).commands(() => ({ run: () => [] })).build();
      const snapshot = query.schemaBindings(built);
      assert.equal(snapshot.commands.wireToSchema['host.run.command'], 'run');
      assert.equal(query.schemaBindings(built.withPlugins()), snapshot);
      const plugin = query.createAggregatePlugin('stamp').commandEnvelope(() => ({ dateTime: new Date(0) })).build();
      assert.equal(query.schemaBindings(built.withPlugins(plugin)), snapshot);
    }
  `], { encoding: 'utf8' });
});

test.each(['source', 'esm', 'cjs'])('strict public binding types: %s', mode => {
  const source = mode === 'source';
  const filename = path.join(__dirname, `schemaBindings.${mode === 'cjs' ? 'cts' : 'mts'}`);
  const options: ts.CompilerOptions = { strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false,
    target: ts.ScriptTarget.ES2022, module: source ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: source ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext, types: [],
    baseUrl: path.resolve(__dirname, '../../..'), paths: source ? {
      '@redemeine/aggregate': ['packages/aggregate/src/index.ts'], '@redemeine/kernel': ['packages/kernel/src/index.ts']
    } : undefined };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = file => file === filename ? `import { schemaBindings, createAggregate, type SchemaBindings } from '@redemeine/aggregate';
    const result: SchemaBindings = schemaBindings(createAggregate('host', {}).build());
    const wire: string = result.commands.schemaToWire.create!.wireType;
    // @ts-expect-error snapshot is readonly
    result.events.wireToSchema['wire'] = 'changed';
    // @ts-expect-error nested binding is readonly
    result.commands.schemaToWire.create!.isWireWinner = false;
  ` : readFile(file);
  const program = ts.createProgram([filename], options, host);
  if (!source) expect(program.getSourceFiles().some(file => file.fileName.includes('/aggregate/src/'))).toBe(false);
  expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
});
