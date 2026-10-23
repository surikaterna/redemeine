import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

test.each(['ts', 'mts', 'cts'])('%s entity handler state matches readonly selected entity declarations', suffix => {
  const fixture = join(__dirname, 'selectedEntityState.fixture.ts.txt');
  const entry = join(__dirname, `selectedEntityFixture.${suffix}`);
  const source = readFileSync(fixture, 'utf8').replace('MODULE', suffix === 'ts' ? '../src' : '@redemeine/aggregate');
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true, types: [],
    target: ts.ScriptTarget.ES2022,
    module: suffix === 'ts' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: suffix === 'ts' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = file => file === entry ? source : readFile(file);
  host.fileExists = file => file === entry || fileExists(file);
  const program = ts.createProgram([entry], options, host);
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  if (suffix !== 'ts') {
    const extension = suffix === 'mts' ? 'd.ts' : 'd.cts';
    expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/index.${extension}`))).toBe(true);
  }
});
