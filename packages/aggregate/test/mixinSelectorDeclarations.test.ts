import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

function compile(files: Map<string, string>, entry: string, options: ts.CompilerOptions, emit: boolean) {
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = file => files.get(file) ?? read(file);
  host.fileExists = file => files.has(file) || exists(file);
  host.writeFile = (file, text) => { files.set(file, text); };
  const program = ts.createProgram([entry], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (emit) diagnostics.push(...program.emit().diagnostics);
  return { program, diagnostics: diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')) };
}

test.each(['ts', 'mts', 'cts'])('%s selectors emit and recompile strict consumer declarations', suffix => {
  const entry = join(__dirname, `mixinSelectorConsumer.${suffix}`);
  const fixture = readFileSync(join(__dirname, 'mixinSelectors.fixture.ts.txt'), 'utf8');
  const source = suffix === 'ts' ? fixture.replace("from '@redemeine/aggregate'", "from '../src'") : fixture;
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, types: [],
    declaration: true, emitDeclarationOnly: true, target: ts.ScriptTarget.ES2022,
    module: suffix === 'ts' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: suffix === 'ts' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext
  };
  const files = new Map([[entry, source]]);
  const result = compile(files, entry, options, true);
  expect(result.diagnostics).toEqual([]);
  if (suffix !== 'ts') {
    const extension = suffix === 'mts' ? 'd.ts' : 'd.cts';
    expect(result.program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/index.${extension}`))).toBe(true);
  }
  const declaration = entry.replace(/\.(ts|mts|cts)$/, suffix === 'ts' ? '.d.ts' : `.d.${suffix}`);
  expect(files.has(declaration)).toBe(true);
  expect(compile(files, declaration, options, false).diagnostics).toEqual([]);
});

test.each(['mirage', 'saga', 'saga-runtime'])('%s fresh source/public declarations remain well-formed', name => {
  for (const sourceMode of [true, false]) {
    const entry = join(__dirname, `../../${name}/test/selectorDownstream.${sourceMode ? 'ts' : 'mts'}`);
    const source = `import * as API from '${sourceMode ? '../src' : `@redemeine/${name}`}'; export { API };`;
    const options: ts.CompilerOptions = {
      strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, types: ['node'], noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: sourceMode ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
      moduleResolution: sourceMode ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext
    };
    if (sourceMode) {
      const config = ts.readConfigFile(join(__dirname, `../../${name}/tsconfig.json`), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(__dirname, `../../${name}`));
      Object.assign(options, parsed.options, { strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false });
    }
    const result = compile(new Map([[entry, source]]), entry, options, false);
    expect(result.diagnostics).toEqual([]);
    expect(result.program.getSourceFiles().some(file => file.fileName.endsWith(
      sourceMode ? `/${name}/src/index.ts` : `/${name}/dist/index.d.ts`))).toBe(true);
  }
});
