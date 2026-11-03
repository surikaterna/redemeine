import { commandMetadata, createAggregate, createEntity, createMixin } from '../src';
import { join } from 'node:path';
import * as ts from 'typescript';

const row = createEntity<{ id: string; code: string }, 'row'>('row')
  .commands(() => ({ read: (state, _payload: Record<string, unknown>) => { expect(state.id).toBe('a'); return []; } })).build();

test('wire winner uses root ownership without changing mounted local-name provenance', () => {
  type State = { rows: { id: string; code: string }[] };
  const source = createMixin<State>().entityList('rows', row).build();
  const mounted = { ...source, mountedEntities: [] };
  const root = createMixin<State>().commands(() => ({ rootRead: (state: State) => { expect(state.rows).toHaveLength(1); return []; } })).build();
  const state = { rows: [{ id: 'a', code: 'c' }] };
  const other = createEntity<{ id: string; code: string }, 'other'>('other').build();
  const overrides = { rowsRead: 'shared.command', rootRead: 'shared.command' };
  const host = createAggregate('store', state).mixins(mounted, root).overrideCommandNames(overrides).entityList('otherRows', other).build();
  expect(Reflect.get(host.pure, 'commandTargets')).toBeUndefined();
  expect(commandMetadata(host, 'rootRead')!.targets).toEqual([]);
  expect(commandMetadata(host, 'rowsRead')!.isWireWinner).toBe(false);
  host.process(state, host.commandCreators.rowsRead());
  const inverse = createAggregate('store', state).mixins(root, mounted).overrideCommandNames(overrides).build();
  expect(commandMetadata(inverse, 'rowsRead')!.targets).toMatchObject([{ kind: 'list', statePath: ['rows'], pk: 'id' }]);
});

test('snapshot deeply detaches provenance without freezing caller primary-key arrays', () => {
  const pk = ['id', 'code'];
  const host = createAggregate('store', { rows: [{ id: 'a', code: 'c' }] }).entityList('rows', row, { pk }).build();
  const snapshot = commandMetadata(host, 'rowsRead')!;
  const target = snapshot.targets[0]!;
  expect(Object.isFrozen(pk)).toBe(false);
  expect(target.pk).not.toBe(pk);
  expect(Reflect.set(snapshot, 'targets', [])).toBe(false);
  expect(Reflect.set(target, 'kind', 'map')).toBe(false);
  expect(Reflect.set(target.statePath, '0', 'wrong')).toBe(false);
  expect(Reflect.set(target.pk!, '0', 'wrong')).toBe(false);
  expect(target).not.toBe(host.mounts.rows!.commandTargets!.rowsRead![0]);
  host.process(host.initialState, host.commandCreators.rowsRead({ id: 'a', code: 'c' }));
});

test.each(['direct', 'mixin', 'nested'] as const)('%s rejects different definition objects at one mount across list/map kinds', location => {
  const first = createEntity<{ id: string }, 'row'>('row').build();
  const second = createEntity<{ id: string }, 'row'>('row').build();
  for (const firstKind of ['entityList', 'entityMap'] as const) {
    for (const secondKind of ['entityList', 'entityMap'] as const) {
      const mount = <T extends { entityList: Function; entityMap: Function; build: Function }>(builder: T) =>
        builder[firstKind]('rows', first)[secondKind]('rows', second).build();
      expect(() => location === 'direct' ? mount(createAggregate('store', {}))
        : location === 'mixin' ? mount(createMixin()) : mount(createEntity('parent')))
        .toThrow(/Conflicting entity definitions at mount "rows"/);
    }
  }
});

test('distinct parent paths may mount different definitions at the same local list/map name', () => {
  const read = (state: { qty: number }) => ({ type: 'read.event', payload: state.qty });
  const first = createEntity<{ id: string; qty: number }, 'row'>('row').commands(() => ({ read })).build();
  const second = createEntity<{ id: string; qty: number }, 'row'>('row').commands(() => ({ read })).build();
  const left = createEntity('left').entityList('rows', first).build();
  const right = createEntity('right').entityMap('rows', second).build();
  const host = createAggregate('store', {
    left: [{ id: 'p', rows: [{ id: 'a', qty: 2 }] }],
    right: [{ id: 'p', rows: { a: { id: 'a', qty: 7 } } }]
  }).entityList('left', left).entityList('right', right).build();
  expect(host.process(host.initialState, host.commandCreators.leftRowsRead({ leftId: 'p', id: 'a' }))[0]!.payload).toBe(2);
  expect(host.process(host.initialState, host.commandCreators.rightRowsRead({ rightId: 'p', key: 'a' }))[0]!.payload).toBe(7);
});

test('aggregate composition compares actual definition objects across direct and flattened mixin mounts', () => {
  const first = createEntity('row').build();
  const second = createEntity('row').build();
  const source = createMixin().entityList('rows', first).build();
  const flattened = { ...source, mountedEntities: [] };
  const conflict = createMixin().entityMap('rows', second).build();
  expect(() => createAggregate('store', {}).mixins(flattened).entityMap('rows', second).build())
    .toThrow(/Conflicting entity definitions at mount "rows"/);
  expect(() => createAggregate('store', {}).mixins(flattened, conflict).build())
    .toThrow(/Conflicting entity definitions at mount "rows"/);
  const reused = createAggregate('store', {}).mixins(flattened).entityMap('rows', first).build();
  expect(reused.mounts.rows).toMatchObject({ kind: 'map', statePath: ['rows'], entity: first });
  const distinct = createAggregate('store', {}).mixins(flattened).entityMap('otherRows', second).build();
  expect(distinct.mounts.otherRows).toMatchObject({ kind: 'map', statePath: ['otherRows'], entity: second });
});

test('different authored paths cannot alias a compiled key, even with wire overrides', () => {
  const first = createEntity('first').commands(() => ({ bRead: () => [] })).build();
  const second = createEntity('second').commands(() => ({ read: () => [] })).build();
  for (const override of [undefined, { commandNameOverrides: { bRead: 'custom.command' } }]) {
    expect(() => createAggregate('store', {}).entityList('a', first, {}, override).entityMap('aB', second).build())
      .toThrow(/Ambiguous authored commands "a.bRead" and "aB.read" compile to "aBRead"/);
  }
  const mounted = createMixin().entityList('a', first).build();
  const root = createMixin().commands(() => ({ aBRead: () => [] })).build();
  expect(() => createAggregate('store', {}).mixins(mounted, root).build()).toThrow(/Ambiguous authored commands/);
});

test('ordinary same-authored-name overrides remain lawful through definition composition', () => {
  const first = createMixin().commands(() => ({ read: () => ({ type: 'read.event', payload: 1 }) })).build();
  const second = createMixin().commands(() => ({ read: () => ({ type: 'read.event', payload: 2 }) })).build();
  const host = createAggregate('store', {}).mixins(first, second).build();
  expect(host.process(host.initialState, host.commandCreators.read())[0]!.payload).toBe(2);
  const entity = createEntity('row').commands(() => ({ read: () => ({ type: 'read.event', payload: 1 }) }))
    .commands(() => ({ read: () => ({ type: 'read.event', payload: 2 }) })).build();
  const mounted = createAggregate('store', { rows: [{ id: 'a' }] }).entityList('rows', entity).entityList('rows', entity).build();
  expect(mounted.process(mounted.initialState, mounted.commandCreators.rowsRead({ id: 'a' }))[0]!.payload).toBe(2);
});

test.each(['ts', 'mts', 'cts'])('%s public provenance retains readonly types and aggregate inference', suffix => {
  const module = suffix === 'ts' ? '../src' : '@redemeine/aggregate';
  const source = `import { commandMetadata, type CommandMetadata, createAggregate, createEntity, type BuiltAggregate } from '${module}';
    // @ts-expect-error parsed-wire routing and its public parser have been retired
    import { parseTargetedEventPath } from '${module}';
    const entity = createEntity<{ id: string }, 'row'>('row').commands(() => ({ read: state => [] })).build();
    export const built = createAggregate('store', { rows: [{ id: 'a' }] }).entityList('rows', entity).build();
    const id: string = built.initialState.rows[0]!.id;
    const registered: typeof entity = built.__registryType!.rows.entity;
    const command = built.commandCreators.rowsRead();
    const registration: CommandMetadata | undefined = commandMetadata(built, 'rowsRead');
    const winner: boolean | undefined = registration?.isWireWinner;
    // @ts-expect-error metadata properties are readonly
    registration!.isWireWinner = false;
    // @ts-expect-error target paths are deeply readonly
    registration!.targets[0]!.statePath.push('bad');
    // @ts-expect-error composite primary keys are deeply readonly
    if (registration!.targets[0]!.pk && typeof registration!.targets[0]!.pk !== 'string') registration!.targets[0]!.pk.push('bad');
    // @ts-expect-error the legacy public target view has been retired
    built.pure.commandTargets;
    const view: Pick<BuiltAggregate, 'pure'> = built;
    // @ts-expect-error explicit BuiltAggregate has no legacy target view either
    view.pure.commandTargets;
    // @ts-expect-error plugin decoration does not restore the removed property
    built.withPlugins().pure.commandTargets;
    // @ts-expect-error undeclared nested creators are not an API
    built.commandCreators.rows('a').read();
    // @ts-expect-error mount aliases are not accepted
    createAggregate('oldEvent', { rows: [] as { id: string }[] }).entityList('rows', entity, {}, { eventOverrides: { changed: 'old.event' } });
    // @ts-expect-error mount aliases are not accepted, even alongside modern options
    createAggregate('oldCommand', { rows: {} as Record<string, { id: string }> }).entityMap('rows', entity, {}, { commandNameOverrides: {}, commandOverrides: { read: 'old.command' } });
    createAggregate('modern', { rows: [] as { id: string }[] }).entityList('rows', entity, {}, { eventNameOverrides: {}, commandNameOverrides: { read: 'modern.command' } });
  `;
  checkDeclarations(source, suffix);
});

function checkDeclarations(source: string, suffix: string) {
  const entry = join(__dirname, `resolvedTargetsFixture.${suffix}`);
  const options: ts.CompilerOptions = { strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, declaration: true, emitDeclarationOnly: true, types: [],
    target: ts.ScriptTarget.ES2022, module: suffix === 'ts' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: suffix === 'ts' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  const files = new Map([[entry, source]]);
  host.readFile = file => files.get(file) ?? originalRead(file);
  host.fileExists = file => files.has(file) || originalExists(file);
  host.writeFile = (file, text) => { files.set(file, text); };
  const program = ts.createProgram([entry], options, host);
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  if (suffix !== 'ts') {
    expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/index.d.${suffix === 'mts' ? 'ts' : 'cts'}`))).toBe(true);
  }
  expect(program.emit().emitSkipped).toBe(false);
  const declaration = entry.replace(/\.(ts|mts|cts)$/, '.d.$1');
  expect(files.has(declaration)).toBe(true);
  expect(ts.getPreEmitDiagnostics(ts.createProgram([declaration], options, host))).toEqual([]);
}
