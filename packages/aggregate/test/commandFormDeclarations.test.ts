import { join } from 'node:path';
import * as ts from 'typescript';

test.each(['ts', 'mts', 'cts'])('%s command form metadata preserves flat signatures', suffix => {
  const entry = join(__dirname, `commandFormFixture.${suffix}`);
  const source = `
import { createAggregate, createEntity, type MapCommandsToPayloads } from '${suffix === 'ts' ? '../src' : '@redemeine/aggregate'}';
type Forms = MapCommandsToPayloads<{
  short: (state: unknown, payload: { id: string; qty: number }) => [];
  object: { handler: (state: unknown, payload: { id: string; qty: number }) => []; meta: { label: string } };
  packed: { pack: (id: string, qty: number) => { id: string; qty: number }; handler: () => [] };
}>;
const short: Forms['short']['form'] = 'shorthand';
const object: Forms['object']['form'] = short;
const packed: Forms['packed']['form'] = 'packed';
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
`;
  const options: ts.CompilerOptions = {
    strict: true, skipLibCheck: false, noEmit: true, types: [], exactOptionalPropertyTypes: true,
    target: ts.ScriptTarget.ES2022, module: suffix === 'ts' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: suffix === 'ts' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = file => file === entry ? source : read(file);
  host.fileExists = file => file === entry || exists(file);
  expect(ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host))
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
});
