import { commandMetadata, createAggregate, createEntity, createMixin } from '../src';
import { join } from 'node:path';
import * as ts from 'typescript';

const row = createEntity<{ id: string; code: string }, 'row'>('row')
  .commands(() => ({ read: (state, _payload: Record<string, unknown>) => { expect(state.id).toBe('a'); return []; } })).build();

test('final local-name provenance replaces historical mounted targets with root ownership', () => {
  type State = { rows: { id: string; code: string }[] };
  const source = createMixin<State>().entityList('rows', row).build();
  const mounted = { ...source, mountedEntities: [] };
  const root = createMixin<State>().commands(() => ({ rowsRead: (state: State) => { expect(state.rows).toHaveLength(1); return []; } })).build();
  const state = { rows: [{ id: 'a', code: 'c' }] };
  const other = createEntity<{ id: string; code: string }, 'other'>('other').build();
  const host = createAggregate('store', state).mixins(mounted, root).entityList('rows', other).build();
  expect(Reflect.get(host.pure, 'commandTargets')).toBeUndefined();
  expect(commandMetadata(host, 'rowsRead')!.targets).toEqual([]);
  host.process(state, host.commandCreators.rowsRead());
  const inverse = createAggregate('store', state).mixins(root, mounted).build();
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
