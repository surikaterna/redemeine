import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

function compile(entry: string, source: string, sourceMode = false) {
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true,
    target: ts.ScriptTarget.ES2022, types: [],
    module: sourceMode ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: sourceMode ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = file => file === entry ? source : readFile(file);
  host.fileExists = file => file === entry || fileExists(file);
  return ts.createProgram([entry], options, host);
}

function expectValid(program: ts.Program) {
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
}

test('built SagaRuntime exports are well-formed for a strict public consumer', () => {
  const program = compile(join(__dirname, 'publicConsumer.mts'),
    `import * as Runtime from '@redemeine/saga-runtime'; void Runtime;
     type IsAny<T> = 0 extends (1 & T) ? true : false;
     const notAny: IsAny<typeof Runtime> = false; void notAny;`);
  expectValid(program);
  expect(program.getSourceFiles().some(file => file.fileName.endsWith('/saga-runtime/dist/index.d.ts'))).toBe(true);
});

test.each(['ts', 'mts', 'cts'])('%s source-event contracts survive the declaration boundary', suffix => {
  const fixtures = join(__dirname, '../../aggregate/test/typefixtures/aggregate-plugins');
  let source = readFileSync(join(fixtures, 'sourceContracts.ts'), 'utf8');
  source += `
    const filler = createAggregatePluginFor(source, 'filler').build();
    const fillers: (typeof filler)[] = [];
    const batches = createAggregate('batches', { count: 0 }).extends(parent)
      .plugins(...fillers).plugins(plugin).plugins(...fillers);
    const validBatches = batches.build();
    validBatches.withPlugins(createAggregatePluginFor(validBatches, 'next').build());
    const invalidBatches = batches.events({ changed(_state, _event: Event<string>) {} });
    // @ts-expect-error Raw source-event contracts must survive multiple phantom-carrying batches.
    invalidBatches.build();
    type IsAny<T> = 0 extends (1 & T) ? true : false;
    const notAny: IsAny<typeof validBatches> = false;
    void notAny;
  `;
  if (suffix !== 'ts') source = source.replace("from '../../../src'", "from '@redemeine/aggregate'");
  const program = compile(join(fixtures, `publicSourceContracts.${suffix}`), source, suffix === 'ts');
  expectValid(program);
  if (suffix !== 'ts') {
    const extension = suffix === 'mts' ? 'd.ts' : 'd.cts';
    expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/index.${extension}`))).toBe(true);
  }
});
