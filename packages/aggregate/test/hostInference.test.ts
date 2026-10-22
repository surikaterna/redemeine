import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../../..');
const fixture = fs.readFileSync(path.join(__dirname, 'hostInference.fixture.ts.txt'), 'utf8');

test.each(['source', 'esm', 'cjs'] as const)('HOST-T6/T9 inference and declarations: %s', mode => {
  const source = mode === 'source';
  const filename = path.join(__dirname, `hostInference.${mode === 'cjs' ? 'cts' : 'mts'}`);
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false,
    declaration: true, emitDeclarationOnly: true, target: ts.ScriptTarget.ES2022,
    module: source ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: source ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
    types: ['node'], baseUrl: root,
    paths: source ? {
      '@redemeine/aggregate': ['packages/aggregate/src/index.ts'],
      '@redemeine/kernel': ['packages/kernel/src/index.ts'],
    } : undefined,
  };
  const files = new Map([[filename, fixture]]);
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = file => files.get(file) ?? readFile(file);
  host.writeFile = (file, text) => { files.set(file, text); };
  const program = ts.createProgram([filename], options, host);
  if (!source) {
    const declaration = mode === 'cjs' ? 'index.d.cts' : 'index.d.ts';
    expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/${declaration}`))).toBe(true);
    expect(program.getSourceFiles().some(file => file.fileName.includes('/aggregate/src/'))).toBe(false);
  }
  expect(diagnostics(program)).toBe('');
  expect(program.emit().emitSkipped).toBe(false);
  const declaration = filename.replace(/\.(mts|cts)$/, '.d.$1');
  expect(files.has(declaration)).toBe(true);
  expect(diagnostics(ts.createProgram([declaration], options, host))).toBe('');
});

function diagnostics(program: ts.Program) {
  return ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), {
    getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  });
}
