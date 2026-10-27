import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { commandMetadata, createAggregate, createAggregatePlugin, createEntity, createMixin } from '../src';

function entity() {
  return createEntity<{ id: string; qty: number }, 'row'>('row')
    .commands(() => ({ set: { pack: (id: string, qty: number) => ({ id, qty }), handler: () => [] } })).build();
}

test('query uses local keys, includes root winners and safely misses prototype keys', () => {
  const built = createAggregate('store', { rows: [] as { id: string; qty: number }[] })
    .commands(() => ({ root: () => [] })).entityList('rows', entity()).build();
  expect(commandMetadata(built, 'root')).toEqual({ localName: 'root', wireType: 'store.root.command',
    winnerLocalName: 'root', isWireWinner: true, targets: [] });
  for (const key of ['store.root.command', 'rows.set', '__proto__', 'constructor', 'missing']) {
    expect(commandMetadata(built, key)).toBeUndefined();
  }
  expect(commandMetadata({ ...built }, 'root')).toBeUndefined();
});

test('prototype-like wire names have ordinary last-winner semantics', () => {
  const first = jest.fn(() => []);
  const last = jest.fn(() => []);
  const built = createAggregate('store', {}).commands(() => ({ first, last }))
    .overrideCommandNames({ first: '__proto__', last: '__proto__' }).build();
  expect(commandMetadata(built, 'first')!.winnerLocalName).toBe('last');
  built.process(built.initialState, built.commandCreators.first());
  expect(first).not.toHaveBeenCalled();
  expect(last).toHaveBeenCalledTimes(1);
});

test('compiled targets detach caller PKs and reject mutation without affecting dispatch', () => {
  const pk = ['id'];
  const built = createAggregate('store', { rows: [{ id: 'a', qty: 1 }] }).entityList('rows', entity(), { pk }).build();
  const registration = commandMetadata(built, 'rowsSet')!;
  const target = registration.targets[0]!;
  expect(Reflect.set(registration, 'isWireWinner', false)).toBe(false);
  expect(Reflect.set(registration.targets, '0', {})).toBe(false);
  expect(Reflect.set(target.statePath, '0', 'wrong')).toBe(false);
  expect(Reflect.set(target.pk!, '0', 'wrong')).toBe(false);
  pk[0] = 'wrong';
  expect(Object.isFrozen(pk)).toBe(false);
  expect(() => built.process(built.initialState, built.commandCreators.rowsSet('a', 2))).not.toThrow();
});

test('creator and dispatch capture descriptor fields without freezing caller definitions or hooks', () => {
  const handler = jest.fn(() => []);
  const definition = { meta: { tag: 'original' }, pack(id: string) { return { id, tag: this.meta.tag }; }, handler };
  const builder = createAggregate('store', {}).commands(() => ({ set: definition }));
  const built = builder.build();
  definition.pack = () => ({ id: 'wrong', tag: 'wrong' });
  definition.handler = jest.fn(() => []);
  definition.meta = { tag: 'wrong' };
  expect(Object.isFrozen(definition)).toBe(false);
  expect(Reflect.set(built.pure.commandProcessors, 'set', () => [])).toBe(false);
  const owned = built.pure.commandProcessors.set!;
  expect(Reflect.set(owned, 'pack', () => ({}))).toBe(false);
  expect(Reflect.set(owned, 'handler', () => [])).toBe(false);
  expect(Reflect.set(owned, 'meta', {})).toBe(false);
  expect(Reflect.set(built.types.commands, 'set', 'wrong.command')).toBe(false);
  const command = built.commandCreators.set('a');
  expect(command.payload).toEqual({ id: 'a', tag: 'wrong' });
  expect(typeof owned !== 'function' && owned.meta).toEqual({ tag: 'original' });
  built.process(built.initialState, command);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(definition.handler).not.toHaveBeenCalled();
  built.hooks = {};
  expect(commandMetadata(built, 'set')!.wireType).toBe(command.type);
  expect(builder.build().commandCreators.set('a').payload).toEqual({ id: 'wrong', tag: 'wrong' });
});

test('descriptor snapshots retain prototype packers and their receiver data', () => {
  class Definition {
    meta = { tag: 'original' };
    pack(id: string) { return { id, tag: this.meta.tag }; }
    handler() { return []; }
  }
  const definition = new Definition();
  const built = createAggregate('store', {}).commands(() => ({ set: definition })).build();
  definition.meta = { tag: 'changed' };
  definition.pack = () => ({ id: 'wrong', tag: 'wrong' });
  expect(built.commandCreators.set('a').payload).toEqual({ id: 'a', tag: 'changed' });
  expect(built.process(built.initialState, built.commandCreators.set('a'))).toEqual([]);
});

test('captured packers retain private brands and original WeakMap identity with live receiver data', () => {
  const identities = new WeakMap<object, string>();
  const originalHandler = jest.fn(() => []);
  class Definition {
    #tag = 'private';
    field = 'original';
    pack(id: string) { return { id, tag: this.#tag, identity: identities.get(this), field: this.field }; }
    handler = originalHandler;
  }
  const definition = new Definition();
  identities.set(definition, 'original identity');
  const originalPack = definition.pack;
  const built = createAggregate('store', {}).commands(() => ({ set: definition })).build();
  const owned = built.pure.commandProcessors.set!;
  expect(typeof owned !== 'function' && owned.pack).toBe(originalPack);
  const registration = commandMetadata(built, 'set')!;
  expect(built.commandCreators.set('a').payload).toEqual({
    id: 'a', tag: 'private', identity: 'original identity', field: 'original'
  });
  definition.pack = () => ({ id: 'wrong', tag: 'wrong', identity: 'wrong', field: 'wrong' });
  definition.handler = jest.fn(() => []);
  definition.field = 'live';
  const command = built.commandCreators.set('b');
  expect(command.payload).toEqual({ id: 'b', tag: 'private', identity: 'original identity', field: 'live' });
  built.process(built.initialState, command);
  expect(originalHandler).toHaveBeenCalledTimes(1);
  expect(definition.handler).not.toHaveBeenCalled();
  expect(Object.isFrozen(definition)).toBe(false);
  expect(Object.isFrozen(originalHandler)).toBe(false);
  expect(commandMetadata(built, 'set')).toBe(registration);
  expect(Object.isFrozen(registration)).toBe(true);
  expect(Object.keys(registration).sort()).toEqual(['isWireWinner', 'localName', 'targets', 'winnerLocalName', 'wireType']);
  const copyBuilder = createAggregate('copy', {}).commands(() => ({ set: owned }));
  const recompiled = copyBuilder.build();
  const inherited = createAggregate('child', {}).extends(copyBuilder).build();
  const plugin = createAggregatePlugin('stamp').commandEnvelope(() => ({ dateTime: new Date(0) })).build();
  for (const copy of [recompiled, inherited, built.withPlugins(plugin)]) {
    expect(copy.commandCreators.set('b').payload).toEqual(command.payload);
    const copied = copy.pure.commandProcessors.set!;
    expect(typeof copied !== 'function' && copied.pack).toBe(originalPack);
  }
});

test('callable definitions ignore attached packers and descriptor snapshots retain own properties', () => {
  const shorthand = Object.assign(() => [], { pack: jest.fn(() => ({ wrong: true })) });
  const definition = { pack: (id: string) => ({ id }), handler: () => [], extra: 'retained' };
  Object.defineProperty(definition, 'hidden', { value: 42, enumerable: false });
  const built = createAggregate('store', {}).commands(() => ({ shorthand, set: definition })).build();
  expect(built.commandCreators.shorthand().payload).toBeUndefined();
  expect(shorthand.pack).not.toHaveBeenCalled();
  const owned = built.pure.commandProcessors.set!;
  expect(Object.getOwnPropertyDescriptor(owned, 'hidden')).toEqual({
    value: 42, enumerable: false, configurable: false, writable: false
  });
  expect(Object.getOwnPropertyDescriptor(owned, 'extra')!.value).toBe('retained');
});

test('decoration, inheritance, mixins and repeated builds retain only their own compiled winners', () => {
  const parentBuilder = createAggregate('store', {}).commands(() => ({ left: () => [], right: () => [] }))
    .overrideCommandNames({ left: 'shared.set.command', right: 'shared.set.command' });
  const parent = parentBuilder.build();
  const plugin = createAggregatePlugin('stamp').commandEnvelope(() => ({ dateTime: new Date(0) })).build();
  const decorated = parent.withPlugins(plugin);
  expect(commandMetadata(decorated, 'left')).toEqual(commandMetadata(parent, 'left'));
  expect(decorated.commandCreators.left().type).toBe(commandMetadata(decorated, 'left')!.wireType);
  const mixin = createMixin<{}>().commands(() => ({ third: () => [] }))
    .overrideCommandNames({ third: 'shared.set.command' }).build();
  const childBuilder = createAggregate('store', {}).extends(parentBuilder).mixins(mixin);
  const child = childBuilder.build();
  expect(commandMetadata(child, 'left')!.winnerLocalName).toBe('third');
  expect(commandMetadata(childBuilder.build(), 'right')!.winnerLocalName).toBe('third');
  expect(commandMetadata(parentBuilder.build(), 'left')!.winnerLocalName).toBe('right');
  expect(commandMetadata(parent, 'left')!.winnerLocalName).toBe('right');
  expect(commandMetadata(decorated, 'left')!.winnerLocalName).toBe('right');
});

const privateCaller = `
import { createAggregate, commandMetadata } from '@redemeine/aggregate';
const identities = new WeakMap<object, string>();
class Definition {
  #tag = 'private';
  field = 'original';
  pack(id: string) { return { id, tag: this.#tag, identity: identities.get(this), field: this.field }; }
  handler() { return []; }
}
export const definition = new Definition();
identities.set(definition, 'identity');
export const built = createAggregate('store', {}).commands(() => ({ set: definition })).build();
export const payload = built.commandCreators.set('a').payload;
`;

test.each(['source', 'esm', 'cjs'] as const)('private descriptor strict public caller and declaration recompile: %s', mode => {
  const source = mode === 'source';
  const filename = path.join(__dirname, `commandMetadata.${mode === 'cjs' ? 'cts' : 'mts'}`);
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false,
    declaration: true, emitDeclarationOnly: true, target: ts.ScriptTarget.ES2022,
    module: source ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: source ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
    types: ['node'], baseUrl: path.resolve(__dirname, '../../..'),
    paths: source ? { '@redemeine/aggregate': ['packages/aggregate/src/index.ts'],
      '@redemeine/kernel': ['packages/kernel/src/index.ts'] } : undefined,
  };
  const files = new Map([[filename, privateCaller]]);
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = file => files.get(file) ?? readFile(file);
  host.writeFile = (file, text) => { files.set(file, text); };
  const program = ts.createProgram([filename], options, host);
  if (!source) {
    expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/index.d.${mode === 'cjs' ? 'cts' : 'ts'}`))).toBe(true);
    expect(program.getSourceFiles().some(file => file.fileName.includes('/aggregate/src/'))).toBe(false);
  }
  expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  expect(program.emit().emitSkipped).toBe(false);
  const declaration = filename.replace(/\.(mts|cts)$/, '.d.$1');
  expect(files.has(declaration)).toBe(true);
  expect(ts.getPreEmitDiagnostics(ts.createProgram([declaration], options, host))).toEqual([]);
});

test.each(['js', 'cjs'])('fresh built private descriptor receiver runtime: %s', extension => {
  const entry = pathToFileURL(path.resolve(__dirname, `../dist/index.${extension}`)).href;
  const script = privateCaller.replace('@redemeine/aggregate', entry).replaceAll('export ', '')
    .replace('WeakMap<object, string>', 'WeakMap').replace('id: string', 'id') + `
    const original = definition.pack;
    if (built.pure.commandProcessors.set.pack !== original) throw Error('packer identity');
    const { createAggregate: otherAggregate } = await import(${JSON.stringify(pathToFileURL(path.resolve(__dirname, `../dist/index.${extension === 'js' ? 'cjs' : 'js'}`)).href)});
    const recompiled = otherAggregate('copy', {}).commands(() => ({ set: built.pure.commandProcessors.set })).build();
    definition.pack = () => ({ id: 'wrong', tag: 'wrong', identity: 'wrong', field: 'wrong' });
    definition.handler = () => { throw Error('replacement handler'); };
    definition.field = 'live';
    const command = built.commandCreators.set('b');
    const expected = { id: 'b', tag: 'private', identity: 'identity', field: 'live' };
    if (JSON.stringify(command.payload) !== JSON.stringify(expected)) throw Error('receiver mismatch');
    if (JSON.stringify(recompiled.commandCreators.set('b').payload) !== JSON.stringify(expected)) throw Error('cross-entry receiver');
    if (recompiled.pure.commandProcessors.set.pack !== original) throw Error('cross-entry identity');
    built.process(built.initialState, command);
    if (Object.isFrozen(definition) || Object.isFrozen(original)) throw Error('caller frozen');
    if (!Object.isFrozen(commandMetadata(built, 'set'))) throw Error('metadata mutable');
  `;
  expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })).not.toThrow();
});
