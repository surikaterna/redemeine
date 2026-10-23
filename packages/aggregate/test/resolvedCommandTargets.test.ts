import { createAggregate, createEntity, createMixin } from '../src';
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
  expect(Object.hasOwn(host.pure.commandTargets, 'rowsRead')).toBe(true);
  expect(host.pure.commandTargets.rowsRead).toEqual([]);
  host.process(state, host.commandCreators.rowsRead());
  const inverse = createAggregate('store', state).mixins(root, mounted).build();
  expect(inverse.pure.commandTargets.rowsRead).toMatchObject([{ kind: 'list', statePath: ['rows'], pk: 'id' }]);
});

test('snapshot deeply detaches provenance without freezing caller primary-key arrays', () => {
  const pk = ['id', 'code'];
  const host = createAggregate('store', { rows: [{ id: 'a', code: 'c' }] }).entityList('rows', row, { pk }).build();
  const snapshot = host.pure.commandTargets;
  const target = snapshot.rowsRead![0]!;
  expect(Object.isFrozen(pk)).toBe(false);
  expect(target.pk).not.toBe(pk);
  expect(Reflect.set(snapshot, 'rowsRead', [])).toBe(false);
  expect(Reflect.set(target, 'kind', 'map')).toBe(false);
  expect(Reflect.set(target.statePath, '0', 'wrong')).toBe(false);
  expect(Reflect.set(target.pk!, '0', 'wrong')).toBe(false);
  expect(target).not.toBe(host.mounts.rows!.commandTargets!.rowsRead![0]);
  host.process(host.initialState, host.commandCreators.rowsRead({ id: 'a', code: 'c' }));
});

test.each(['ts', 'mts', 'cts'])('%s public provenance retains readonly types and aggregate inference', suffix => {
  const module = suffix === 'ts' ? '../src' : '@redemeine/aggregate';
  const source = `import { createAggregate, createEntity, type BuiltAggregate } from '${module}';
    const entity = createEntity<{ id: string }, 'row'>('row').commands(() => ({ read: state => [] })).build();
    const built = createAggregate('store', { rows: [{ id: 'a' }] }).entityList('rows', entity).build();
    const id: string = built.initialState.rows[0]!.id;
    const registered: typeof entity = built.__registryType!.rows.entity;
    const command = built.commandCreators.rowsRead();
    const target = built.pure.commandTargets.rowsRead![0]!;
    const path: readonly string[] = target.statePath;
    // @ts-expect-error snapshot entries are readonly
    built.pure.commandTargets.rowsRead = [];
    // @ts-expect-error target paths are readonly
    target.statePath.push('bad');
    // @ts-expect-error composite primary keys are readonly
    if (target.pk && typeof target.pk !== 'string') target.pk.push('bad');
    const view: Pick<BuiltAggregate, 'pure'> = built;
    const other: readonly string[] = view.pure.commandTargets.rowsRead![0]!.statePath;
    // @ts-expect-error explicit BuiltAggregate snapshot is readonly too
    view.pure.commandTargets.rowsRead = [];
  `;
  const entry = join(__dirname, `resolvedTargetsFixture.${suffix}`);
  const options: ts.CompilerOptions = { strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true, types: [],
    target: ts.ScriptTarget.ES2022, module: suffix === 'ts' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: suffix === 'ts' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  host.readFile = file => file === entry ? source : originalRead(file);
  host.fileExists = file => file === entry || originalExists(file);
  const program = ts.createProgram([entry], options, host);
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  if (suffix !== 'ts') {
    expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/index.d.${suffix === 'mts' ? 'ts' : 'cts'}`))).toBe(true);
  }
});
