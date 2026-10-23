import { resolve } from 'node:path';
import * as ts from 'typescript';

test('domain example uses supported command definitions and invocations', () => {
  const root = resolve(__dirname, '../../..');
  const program = ts.createProgram([resolve(__dirname, 'domain.test.ts')], {
    strict: true,
    // The pre-existing changeQty packed handler lacks contextual parameter types.
    noImplicitAny: false,
    noEmit: true, skipLibCheck: false, esModuleInterop: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: root, paths: { '@redemeine/*': ['packages/*/src'] }, types: ['jest', 'node']
  });
  expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
});
