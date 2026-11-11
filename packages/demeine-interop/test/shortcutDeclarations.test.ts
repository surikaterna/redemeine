import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

function compile(entry: string, source: string, options: ts.CompilerOptions, extra = new Map<string, string>()) {
  const files = new Map(extra).set(entry, source);
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = file => files.get(file) ?? readFile(file);
  host.fileExists = file => files.has(file) || fileExists(file);
  const emitted = new Map<string, string>();
  host.writeFile = (file, text) => { emitted.set(file, text); };
  const program = ts.createProgram([entry], options, host);
  const emit = program.emit();
  expect([...ts.getPreEmitDiagnostics(program), ...emit.diagnostics].map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  return { program, emitted };
}

test.each(['aliases.mts', 'aliasKeys.mts', 'spread.mts'].flatMap(fixture => ['source', 'mts', 'cts'].map(mode => [fixture, mode])))(
  '%s %s direct list aliases preserve exact flat signatures and exclusions', (fixture, mode) => {
    const directory = join(__dirname, 'typefixtures');
    const entry = join(directory, `checked-aliases.${mode === 'source' ? 'ts' : mode}`);
    let source = readFileSync(join(directory, fixture), 'utf8');
    if (mode === 'source') source = source.replaceAll("from '@redemeine/demeine-interop'", "from '../../src'");
    const { program } = compile(entry, source, {
      strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true,
      target: ts.ScriptTarget.ES2022, types: mode === 'source' ? ['node'] : [],
      module: mode === 'source' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
      moduleResolution: mode === 'source' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
    });
    if (mode !== 'source') {
      const suffix = mode === 'mts' ? 'd.ts' : 'd.cts';
      expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/demeine-interop/dist/index.${suffix}`))).toBe(true);
      expect(program.getSourceFiles().some(file => file.fileName.includes('/demeine-interop/src/'))).toBe(false);
    }
  }
);

test.each(['aliases.mts', 'aliasKeys.mts'].flatMap(fixture => ['source', 'mts', 'cts'].map(mode => [fixture, mode])))(
  '%s %s open command maps reject phantom aliases as missing properties', (fixture, mode) => {
    const directory = join(__dirname, 'typefixtures');
    const entry = join(directory, `missing-alias.${mode === 'source' ? 'ts' : mode}`);
    let source = readFileSync(join(directory, fixture), 'utf8')
      .replace('// @ts-expect-error widened command keys cannot promise a fabricated alias', '')
      .replaceAll('// @ts-expect-error open command key has no guaranteed alias', '');
    if (mode === 'source') source = source.replaceAll("from '@redemeine/demeine-interop'", "from '../../src'");
    const options: ts.CompilerOptions = {
      strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true,
      target: ts.ScriptTarget.ES2022, types: mode === 'source' ? ['node'] : [],
      module: mode === 'source' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
      moduleResolution: mode === 'source' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
    };
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.readFile = file => file === entry ? source : readFile(file);
    host.fileExists = file => file === entry || fileExists(file);
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
    expect(diagnostics).toHaveLength(fixture === 'aliases.mts' ? 1 : 10);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toBe(2339);
      expect(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .toMatch(/Property '.*Identifier' does not exist on type/);
    }
  }
);

test.each(['source', 'mts', 'cts'])('%s shortcut correlation survives admission and declaration emission', mode => {
  const directory = join(__dirname, 'typefixtures');
  const entry = join(directory, `emitted-shortcuts.${mode === 'source' ? 'ts' : mode}`);
  let source = readFileSync(join(directory, 'shortcuts.mts'), 'utf8');
  if (mode === 'source') source = source.replaceAll("from '@redemeine/demeine-interop'", "from '../../src'");
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, declaration: true, emitDeclarationOnly: true,
    target: ts.ScriptTarget.ES2022, types: mode === 'source' ? ['node'] : [],
    module: mode === 'source' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: mode === 'source' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
  };
  const { program, emitted } = compile(entry, source, options);
  if (mode !== 'source') {
    const suffix = mode === 'mts' ? 'd.ts' : 'd.cts';
    expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/demeine-interop/dist/index.${suffix}`))).toBe(true);
    expect(program.getSourceFiles().some(file => file.fileName.includes('/demeine-interop/src/'))).toBe(false);
  }
  const extension = mode === 'source' ? 'js' : mode === 'mts' ? 'mjs' : 'cjs';
  compile(join(directory, `consumer.${mode === 'source' ? 'ts' : mode}`), `
    import { TupleBridge } from './emitted-shortcuts.${extension}';
    const caller = new TupleBridge();
    caller.go('a', { a: 1 });
    caller.go('b', { b: 'ok' });
    // @ts-expect-error emitted consumers retain correlation
    caller.go('a', { b: 'wrong branch' });
    // @ts-expect-error emitted consumers retain literal payloads
    caller.literal({ kind: 'fixed', value: 2 });
  `, { ...options, noEmit: true, emitDeclarationOnly: false }, emitted);
});
