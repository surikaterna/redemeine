import { commandMetadata, createAggregate, createEntity, createMixin } from '../src';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { definitionTargets, mergeDefinitions } from '../src/build/entityCommandTarget';

const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'] as const;

test('definition merges create own data properties without changing destination prototypes', () => {
  const definitions = { ['__proto__']: () => [] };
  const destination = {};
  const merged = mergeDefinitions(destination, definitions);
  expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  expect(Object.hasOwn(merged, '__proto__')).toBe(true);
  expect(Reflect.get(merged, '__proto__')).toBe(definitions[names[0]]);
  expect(Object.getPrototypeOf(definitionTargets(merged))).toBeNull();
  expect(definitionTargets(merged)[names[0]]).toEqual([]);
});

test.each(['ts', 'mts', 'cts'])('%s declarations preserve own prototype-like method signatures', suffix => {
  const entry = join(__dirname, `prototypeRegistration.${suffix}`);
  const source = readFileSync(join(__dirname, 'prototypeRegistration.fixture.ts.txt'), 'utf8')
    .replace("from '@redemeine/aggregate'", suffix === 'ts' ? "from '../src'" : "from '@redemeine/aggregate'");
  const options: ts.CompilerOptions = { strict: true, skipLibCheck: false, noEmit: true,
    target: ts.ScriptTarget.ES2022, types: [], exactOptionalPropertyTypes: true,
    module: suffix === 'ts' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: suffix === 'ts' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext };
  const compiler = ts.createCompilerHost(options);
  const read = compiler.readFile.bind(compiler);
  const exists = compiler.fileExists.bind(compiler);
  compiler.readFile = file => file === entry ? source : read(file);
  compiler.fileExists = file => file === entry || exists(file);
  const program = ts.createProgram([entry], options, compiler);
  expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  if (suffix !== 'ts') expect(program.getSourceFiles().some(file =>
    file.fileName.endsWith(`/aggregate/dist/index.${suffix === 'mts' ? 'd.ts' : 'd.cts'}`))).toBe(true);
});

test.each(names)('root declared %s commands and events are ordinary own keys', key => {
  const events = { [key]: (draft: { qty: number }) => { draft.qty++; } };
  const commands = { [key]: () => ({ type: `probe.${key}.event`, payload: {} }) };
  const host = createAggregate('probe', { qty: 0 }).events(events).commands(() => commands)
    .overrideEventNames({ [key]: `probe.${key}.event` }).build();
  const command = host.commandCreators[key]();
  expect(commandMetadata(host, key)).toMatchObject({ localName: key, targets: [], isWireWinner: true });
  const [event] = host.process(host.initialState, command);
  expect(host.apply(host.initialState, event!)).toEqual({ qty: 1 });
  const draft = { qty: 0 };
  host.applyToDraft(draft, event!);
  expect(draft.qty).toBe(1);
  expect(Object.getPrototypeOf(events)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(commands)).toBe(Object.prototype);
  expect(Object.hasOwn(commands, key)).toBe(true);
  expect(Reflect.get(host.commandCreators, 'missing')).toBeUndefined();
});

test.each(names)('emit and component composition preserve declared %s', key => {
  const row = createEntity<{ id: string; qty: number }, 'row'>('row')
    .events({ [key]: (draft, event: { payload: { qty: number } }) => { draft.qty = event.payload.qty; } })
    .commands(emit => ({ [key]: (_state, payload: { id: string; qty: number }) => emit[key](payload) })).build();
  const mixin = createMixin<{ qty: number }>().events({ [key]: draft => { draft.qty++; } })
    .commands(emit => ({ [key]: () => emit[key]({}) })).build();
  const host = createAggregate('probe', { qty: 0, rows: [{ id: 'a', qty: 1 }] })
    .mixins(mixin).entityList('rows', row).build().withPlugins();
  const mapped = `rows${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  const rootEvent = host.process(host.initialState, host.commandCreators[key]())[0]!;
  expect(host.apply(host.initialState, rootEvent).qty).toBe(1);
  const event = host.process(host.initialState, Reflect.get(host.commandCreators, mapped)({ id: 'a', qty: 3 }))[0]!;
  expect(host.apply(host.initialState, event)).toEqual({ qty: 0, rows: [{ id: 'a', qty: 3 }] });
  const draft = structuredClone(host.initialState);
  host.applyToDraft(draft, event);
  expect(draft.rows[0]!.qty).toBe(3);
  expect(() => host.apply(host.initialState, { ...event, payload: {} })).toThrow('Invalid mounted command target');
});
