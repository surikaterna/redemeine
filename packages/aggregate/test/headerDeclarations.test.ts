import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

test.each(['mts', 'cts'])('public %s declarations preserve header inference and negative contracts', suffix => {
  const entry = join(__dirname, `typefixtures/publicHeaders.${suffix}`);
  const source = readFileSync(join(__dirname, 'typefixtures/envelopes/headers.ts'), 'utf8')
    .replace("from '../../../src'", "from '@redemeine/aggregate'");
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, types: []
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = file => file === entry ? source : readFile(file);
  host.fileExists = file => file === entry || fileExists(file);
  const program = ts.createProgram([entry], options, host);
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  const extension = suffix === 'mts' ? 'd.ts' : 'd.cts';
  expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/index.${extension}`))).toBe(true);
});
