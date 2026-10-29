import { join } from 'node:path';
import * as ts from 'typescript';

test.each(['ts', 'mts', 'cts'])('%s command form metadata preserves flat signatures', suffix => {
  const entry = join(__dirname, `commandFormFixture.${suffix}`);
  const source = `
import { createAggregate, createEntity, createMixin, type MapCommandsToPayloads } from '${suffix === 'ts' ? '../src' : '@redemeine/aggregate'}';
type Forms = MapCommandsToPayloads<{
  short: (state: unknown, payload: { id: string; qty: number }) => [];
  object: { handler: (state: unknown, payload: { id: string; qty: number }) => []; meta: { label: string } };
  packed: { pack: (id: string, qty: number) => { id: string; qty: number }; handler: () => [] };
  callable: ((state: unknown, payload?: { id: string; qty: number }) => []) & {
    pack: (qty: number) => number; handler: () => [];
  };
}>;
const short: Forms['short']['form'] = 'shorthand';
const object: Forms['object']['form'] = short;
const packed: Forms['packed']['form'] = 'packed';
const callable: Forms['callable']['form'] = 'shorthand';
const args: Forms['callable']['args'] = [{ id: 'a', qty: 1 }];
const absent: Forms['callable']['payload'] = undefined;
// @ts-expect-error Attached pack does not replace the callable payload or form.
const packedCallable: Forms['callable']['form'] = 'packed';
void [callable, args, absent, packedCallable];
const row = createEntity<{ id: string; qty: number }, 'row'>('row').events({})
  .commands(() => ({ set: (_state, _payload: { id: string; qty: number }) => [],
    setQuantity: { pack: (id: string, qty: number) => ({ id, qty }), handler: () => [] } })).build();
const host = createAggregate('store', { rows: [] as { id: string; qty: number }[] }).entityList('rows', row).build();
host.commandCreators.rowsSet({ id: 'a', qty: 1 });
host.commandCreators.rowsSetQuantity('a', 1);
// @ts-expect-error Flat object creators keep identity required.
host.commandCreators.rowsSet({ qty: 1 });
// @ts-expect-error Flat packed creators keep the selected-identity prefix.
host.commandCreators.rowsSetQuantity(1);
// @ts-expect-error Form is a literal discriminator, not any.
const invalid: Forms['short']['form'] = 'packed';
void [short, object, packed, invalid];
type Identifier = { domain: string; authority: string; identifier: string };
const initial: Identifier = { domain: '', authority: '', identifier: '' };
export const identifier = createEntity('identifier', initial).commands(() => ({
  register(state, payload: Identifier, context) {
    const isNew: boolean = context.isNew;
    const value: string = state.identifier;
    // @ts-expect-error Entity decision state is borrowed readonly.
    state.identifier = payload.identifier;
    // @ts-expect-error Framework context is readonly.
    context.isNew = false;
    return [];
  },
  packed: {
    pack: (domain: string, authority: string, identifier: string) => ({ domain, authority, identifier }),
    handler(state, payload: Identifier, { isNew }) {
      const value: string = payload.identifier;
      const existing: string = state.identifier;
      const flag: boolean = isNew;
      return [];
    }
  }
}), { static: ['register', 'packed'] }).build();
export const registry = createAggregate('registry', { identifiers: [] as Identifier[] })
  .entityList('identifiers', identifier, { pk: ['domain', 'authority'] }, { semanticName: 'externalID' }).build();
registry.commandCreators.identifiersRegister(initial);
const packedPayload: Identifier = registry.commandCreators.identifiersPacked('d', 'a', 'i').payload;
export const nestedParent = createEntity('parent', { id: '', identifiers: [] as Identifier[] })
  .entityList('identifiers', identifier, { pk: ['domain', 'authority'] }, { semanticName: 'externalID' })
  .commands(() => ({ touch: () => [] })).build();
type ChildRegistration = NonNullable<typeof nestedParent.__registryType>['identifiers'];
const nestedKey: ChildRegistration['pk'] = ['domain', 'authority'];
const nestedStatic: true = null as unknown as ChildRegistration['entity']['commands']['packed']['__staticCommand'];
// @ts-expect-error Nested registry retains the exact composite key.
const wrongNestedKey: ChildRegistration['pk'] = 'id';
void [nestedKey, nestedStatic, wrongNestedKey];
createMixin<{ identifiers: Identifier[] }>().entityList('identifiers', identifier, {}, { semanticName: 'externalID' }).build();
// @ts-expect-error Semantic aliases are strings on Aggregate mounts.
createAggregate('badAlias', { identifiers: [] as Identifier[] }).entityList('identifiers', identifier, {}, { semanticName: 1 });
// @ts-expect-error Semantic aliases are strings on Entity mounts.
createEntity('badAlias', { identifiers: [] as Identifier[] }).entityList('identifiers', identifier, {}, { semanticName: 1 });
// @ts-expect-error Semantic aliases are strings on Mixin mounts.
createMixin<{ identifiers: Identifier[] }>().entityList('identifiers', identifier, {}, { semanticName: 1 });
// @ts-expect-error Framework context is not a caller argument.
registry.commandCreators.identifiersRegister(initial, { isNew: true });
// @ts-expect-error Pack alone controls caller arguments.
registry.commandCreators.identifiersPacked('d', 'a', 'i', { isNew: true });
// @ts-expect-error Pack tuple argument types remain exact.
registry.commandCreators.identifiersPacked('d', 1, 'i');
// @ts-expect-error Static names must be returned by this factory.
createEntity('checked', initial).commands(() => ({ register: () => [] }), { static: ['missing'] });
const optionalContext = createEntity('optionalContext', initial).commands(() => ({
  read(_state, payload?: Identifier, context?: { readonly isNew: boolean }) { return []; }
})).build();
const optionalHost = createAggregate('optionalHost', { rows: [] as Identifier[] }).entityList('rows', optionalContext).build();
optionalHost.commandCreators.rowsRead();
optionalHost.commandCreators.rowsRead(initial);
// @ts-expect-error Optional framework context is not a public argument either.
optionalHost.commandCreators.rowsRead(initial, { isNew: false });
`;
  const options: ts.CompilerOptions = {
    strict: true, skipLibCheck: false, declaration: true, emitDeclarationOnly: true, types: [], exactOptionalPropertyTypes: true,
    target: ts.ScriptTarget.ES2022, module: suffix === 'ts' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: suffix === 'ts' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const files = new Map([[entry, source]]);
  host.readFile = file => files.get(file) ?? read(file);
  host.fileExists = file => files.has(file) || exists(file);
  host.writeFile = (file, text) => { files.set(file, text); };
  const program = ts.createProgram([entry], options, host);
  expect(ts.getPreEmitDiagnostics(program)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  if (suffix !== 'ts') {
    expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/index.d.${suffix === 'mts' ? 'ts' : 'cts'}`))).toBe(true);
  }
  expect(program.emit().emitSkipped).toBe(false);
  const declaration = entry.replace(/\.(ts|mts|cts)$/, '.d.$1');
  expect(files.has(declaration)).toBe(true);
  expect(ts.getPreEmitDiagnostics(ts.createProgram([declaration], options, host))).toEqual([]);
});
