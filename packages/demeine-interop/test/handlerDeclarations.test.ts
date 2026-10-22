import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../../..');
const fixture = fs.readFileSync(path.join(__dirname, 'handlerVariance.fixture.ts.txt'), 'utf8');

test.each(['source', 'esm', 'cjs'] as const)('handler inputs are sound in %s contracts', mode => {
  const source = mode === 'source';
  const extension = mode === 'cjs' ? 'cts' : 'mts';
  const filename = path.join(__dirname, `handlerVariance.${extension}`);
  const entry = (name: string) => path.join(root, 'packages', name,
    source ? 'src/index.ts' : `dist/index.d.${mode === 'cjs' ? 'cts' : 'ts'}`);
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: source ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: source ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
    types: ['node'], baseUrl: root,
    paths: {
      '@redemeine/aggregate': [entry('aggregate')],
      '@redemeine/demeine-interop': [entry('demeine-interop')],
      '@redemeine/kernel': [entry('kernel')],
    },
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile;
  host.readFile = file => file === filename ? fixture : readFile(file);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  })).toBe('');
});
