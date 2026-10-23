import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';

const downstream: Record<string, string> = {
  'demeine-interop': `
    import { createDemeineBridge } from '@redemeine/demeine-interop';
    const live = new (createDemeineBridge(host))();
    live.zero(); live.stateOnly(); live.optional(); live.optional(undefined);
    live.optional({ name: 'ok' }); live.required({ name: 'ok' }); live.packed('ok', 2);
    // @ts-expect-error Bridge retains required object arity.
    live.required();
  `,
  mirage: `
    import { createMirage } from '@redemeine/mirage';
    const mirage = createMirage(host, 'one');
    mirage.zero(); mirage.optional(); mirage.optional(undefined);
    mirage.required({ name: 'ok' }); mirage.packed('ok', 2);
    // @ts-expect-error Mirage retains required object arity.
    mirage.required();
  `
};
const cases = [['ts', 'aggregate'], ['mts', 'demeine-interop'], ['cts', 'demeine-interop'], ['mts', 'mirage'], ['cts', 'mirage']];

const fixtures = ['shorthandCommands.fixture.ts.txt', '../../mirage/test/callableCommands.fixture.ts.txt'];
const programs = [
  ...cases.map(([suffix, consumerPackage]) => [suffix, consumerPackage, fixtures[0]]),
  ['ts', 'aggregate', fixtures[1]], ['mts', 'mirage', fixtures[1]],
  ['ts', 'aggregate', '../../mirage/test/scopedCommands.fixture.ts.txt'],
  ['mts', 'mirage', '../../mirage/test/scopedCommands.fixture.ts.txt']
];
test.each(programs)(
  '%s %s %s declarations match single-payload runtime', (suffix, consumerPackage, fixture) => {
  const entry = resolve(__dirname, `../../${consumerPackage}/test/shorthandConsumer.${suffix}`);
  let source = readFileSync(join(__dirname, fixture), 'utf8');
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false,
    declaration: true, emitDeclarationOnly: true, target: ts.ScriptTarget.ES2022,
    module: suffix === 'ts' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: suffix === 'ts' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
    types: [], rootDir: resolve(__dirname, '../../..'),
    outDir: resolve(__dirname, `../../${consumerPackage}/test/.shorthand-declarations`)
  };
  if (suffix === 'ts') {
    source = source.replaceAll("'@redemeine/aggregate'", "'../src'");
    source = source.replaceAll("'@redemeine/mirage'", "'../../mirage/src'");
    if (fixture !== fixtures[0]) options.types = ['node'];
    options.baseUrl = resolve(__dirname, '../../..');
    options.paths = { '@redemeine/kernel': ['packages/kernel/src/index.ts'], '@redemeine/aggregate': ['packages/aggregate/src/index.ts'] };
  } else if (fixture === fixtures[0]) source += downstream[consumerPackage];
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = file => file === entry ? source : read(file);
  host.fileExists = file => file === entry || exists(file);
  const program = ts.createProgram([entry], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(diagnostics.map(d => `${d.file?.fileName}:${d.start}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)).toEqual([]);
  if (suffix !== 'ts') {
    expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/index.d.${suffix === 'mts' ? 'ts' : 'cts'}`))).toBe(true);
  }
  const emitted = new Map<string, string>();
  expect(program.emit(undefined, (file, text) => emitted.set(file, text)).diagnostics).toEqual([]);
  if (suffix !== 'ts') {
    const declarationHost = ts.createCompilerHost(options);
    declarationHost.readFile = file => emitted.get(file) ?? read(file);
    declarationHost.fileExists = file => emitted.has(file) || exists(file);
    const consumer = ts.createProgram([...emitted.keys()], { ...options, noEmit: true }, declarationHost);
    expect(ts.getPreEmitDiagnostics(consumer).map(d => `${ts.flattenDiagnosticMessageText(d.messageText, '\n')}: ${d.file?.text.slice(Math.max(0, (d.start ?? 0) - 150), (d.start ?? 0) + 150)}`)).toEqual([]);
  }
});
