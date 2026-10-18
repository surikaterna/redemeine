import * as path from 'node:path';
import * as ts from 'typescript';

const root = path.resolve(__dirname, '../../..');
const fixture = path.join(__dirname, 'typefixtures/inferredAggregate.ts');
const declaration = fixture.replace(/\.ts$/, '.d.ts');
const options: ts.CompilerOptions = {
  strict: true, skipLibCheck: false, target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  declaration: true, emitDeclarationOnly: true, types: [],
  paths: { '@redemeine/kernel': [path.join(root, 'packages/kernel/src/index.ts')] }
};

function compile(files: Map<string, string>, entry: string, emit: boolean) {
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = file => files.get(file) ?? readFile(file);
  host.fileExists = file => files.has(file) || fileExists(file);
  host.writeFile = (file, text) => { files.set(file, text); };
  const program = ts.createProgram([entry], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (emit) diagnostics.push(...program.emit().diagnostics);
  return diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

test('inferred generic aggregate factories emit self-contained replacement event maps', () => {
  const files = new Map([[fixture, `
    import { createAggregate } from '../../src';
    import type { Event } from '@redemeine/kernel';
    export function factory<Name extends string>(name: Name) {
      return createAggregate(name, { count: 0 })
        .events({ changed(state, event: Event<number>) { state.count += event.payload; } })
        .events({ changed(state, event: Event<string>) { state.count += event.payload.length; } })
        .build();
    }
  `]]);
  expect(compile(files, fixture, true)).toEqual([]);
  expect(files.has(declaration)).toBe(true);
  expect(compile(files, declaration, false)).toEqual([]);
});
