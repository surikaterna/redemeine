import { resolve, join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as ts from 'typescript';
import { createProgramFromConfig } from '../../src/cli/extract/aggregateNavigator';
import { classifyDefinition } from '../../src/cli/extract/schemaRegistryDefinitionClassifier';
import { moduleValues, selectedSymbol } from '../../src/cli/extract/schemaRegistryIdentity';
import { discoverRegistrySelections } from '../../src/cli/extract/schemaRegistryDiscovery';
import { navigateRegistries } from '../../src/cli/extract/schemaRegistryNavigator';
import { generateSchemaRegistryOutput } from '../../src/cli/extract/schemaRegistryOutputGenerator';
import * as aggregateNavigator from '../../src/cli/extract/aggregateNavigator';
import { extractSchemaRegistries } from '../../src/reflector';

const fixtures = resolve(__dirname, 'fixtures/registries/discovery');
let program: ts.Program;
beforeAll(() => { program = createProgramFromConfig(join(fixtures, 'tsconfig.json')); });

test('strict mixed fixture compiles without evaluating throwing source', () => {
  expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
});

test('genuine anonymous aggregate and public/runtime ordinary/commit contracts independently classify', () => {
  const values = moduleValues(program, join(fixtures, 'mixed.ts'));
  const found = [...values].flatMap(([name, symbol]) => {
    const candidate = classifyDefinition(program.getTypeChecker(), symbol);
    if (!candidate) return [];
    candidate.validate();
    return [[name, candidate.evidence.kind, candidate.evidence.commit]];
  });
  expect(found).toEqual([
    ['account', 'aggregate', false], ['accountAlias', 'aggregate', false], ['annotation', 'projection', false],
    ['cast', 'projection', false], ['default', 'aggregate', false], ['mirror', 'projection', false],
    ['publicAlias', 'projection', false], ['publicCommit', 'projection', true], ['publicView', 'projection', false],
    ['runtimeCommit', 'projection', true], ['runtimeView', 'projection', false], ['unionAggregate', 'aggregate', false],
  ]);
});

test('type-only named and star reexports are not value routes', () => {
  const values = moduleValues(program, join(fixtures, 'barrel.ts'));
  expect(values.has('renamedAccount')).toBe(true);
  expect(values.has('typeAccount')).toBe(false);
  expect(values.has('typePublic')).toBe(false);
  expect(moduleValues(program, join(fixtures, 'types.ts')).size).toBe(0);
  expect([...moduleValues(program, join(fixtures, 'typeAndValue.ts')).keys()]).toEqual(['account']);
});

test('recognized unsupported states stay eligible; malformed and erased contracts fail validation', () => {
  const unsupported = createProgramFromConfig(join(fixtures, 'unsupported.json'));
  const values = moduleValues(unsupported, join(fixtures, 'unsupported.ts'));
  expect(selectedSymbol(unsupported, join(fixtures, 'unsupported.ts'), 'mutableSnapshot'))
    .not.toBe(selectedSymbol(unsupported, join(fixtures, 'unsupported.ts'), 'mutableAlias'));
  for (const name of ['badState', 'badCommand', 'badEvent', 'badProjection']) {
    const candidate = classifyDefinition(unsupported.getTypeChecker(), values.get(name)!);
    expect(candidate).toBeDefined();
    expect(() => candidate!.validate()).not.toThrow();
  }
  for (const name of ['malformed', 'erased', 'ambiguous']) {
    const candidate = classifyDefinition(unsupported.getTypeChecker(), values.get(name)!);
    expect(candidate).toBeDefined();
    expect(() => candidate!.validate()).toThrow();
  }
});

test('unresolved unrelated alias cycles are ignored rather than mistaken for built candidates', () => {
  const file = join(fixtures, 'virtual-cycle.ts');
  const source = ts.createSourceFile(file, 'export const a = b; export const b = a;', ts.ScriptTarget.ES2022, true);
  const host = ts.createCompilerHost({});
  const originalSource = host.getSourceFile;
  host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) => name === file ? source :
    originalSource(name, version, onError, shouldCreateNewSourceFile);
  const compiler = ts.createProgram([file], {}, host);
  expect(classifyDefinition(compiler.getTypeChecker(), moduleValues(compiler, file).get('a')!)).toBeUndefined();
});

function declarationProgram(entryName = 'declarations'): ts.Program {
  const source = createProgramFromConfig(join(fixtures, `${entryName}.json`));
  const declarations = new Map<string, string>();
  const emitter = ts.createProgram(source.getRootFileNames(), { ...source.getCompilerOptions(), noEmit: false,
    declaration: true, emitDeclarationOnly: true, declarationMap: false });
  const result = emitter.emit(undefined, (file, text) => declarations.set(file, text));
  expect(result.emitSkipped).toBe(false);
  const options = source.getCompilerOptions();
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile;
  const originalExists = host.fileExists;
  host.readFile = (file) => declarations.get(file) ?? originalRead(file);
  host.getSourceFile = (file, languageVersion) => {
    const text = host.readFile(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
  };
  // Keep consumer sources; only package resolution is redirected to emitted declarations.
  const entry = join(fixtures, `${entryName}.ts`);
  host.fileExists = (file) => declarations.has(file) ||
    ((!file.includes('/packages/') || !declarations.has(file.replace(/\.ts$/, '.d.ts'))) && originalExists(file));
  return ts.createProgram([entry], options, host);
}

test('emitted genuine package .d.ts declarations retain anonymous build and ordinary/commit factory evidence', () => {
  const compiler = declarationProgram();
  const packages = compiler.getSourceFiles().filter((file) => /packages\/(aggregate|projection|projection-runtime-core)\/src\//.test(file.fileName));
  expect(packages.length).toBeGreaterThan(0);
  expect(packages.every((file) => file.isDeclarationFile)).toBe(true);
  expect(ts.getPreEmitDiagnostics(compiler).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  const values = moduleValues(compiler, join(fixtures, 'declarations.ts'));
  for (const [name, symbol] of values) {
    const candidate = classifyDefinition(compiler.getTypeChecker(), symbol);
    expect(candidate?.evidence).toEqual({ kind: name === 'declaredAggregate' ? 'aggregate' : 'projection', commit: name.endsWith('Commit') });
    expect(() => candidate!.validate()).not.toThrow();
  }
});

test.each(['source', 'declarations'])('nested malformed built contracts reject with genuine %s package evidence', (mode) => {
  const compiler = mode === 'source' ? createProgramFromConfig(join(fixtures, 'nestedContracts.json')) : declarationProgram('nestedContracts');
  expect(ts.getPreEmitDiagnostics(compiler).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  for (const [name, symbol] of moduleValues(compiler, join(fixtures, 'nestedContracts.ts'))) {
    const candidate = classifyDefinition(compiler.getTypeChecker(), symbol);
    expect(candidate).toBeDefined();
    expect(() => candidate!.validate()).toThrow(/(result|payload mismatch|missing corresponding event creator|genuine aggregate contract reference|required built member)/);
    expect(name).toMatch(/^bad/);
  }
});

test.each(['source', 'declarations'])('public sources and narrow public/runtime join/subscription contexts remain valid with %s evidence', (mode) => {
  const compiler = mode === 'source' ? createProgramFromConfig(join(fixtures, 'declarations.json')) : declarationProgram();
  expect(ts.getPreEmitDiagnostics(compiler).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  const names = { declaredPublic: 'declared-public', declaredRuntime: 'declared-runtime', declaredPublicCommit: 'declared-public-commit',
    declaredRuntimeCommit: 'declared-runtime-commit', declaredPublicSource: 'public-source', declaredPublicNarrow: 'public-narrow',
    declaredRuntimeNarrowRoutes: 'runtime-narrow-routes' };
  const selections = discoverRegistrySelections(compiler, [], [
    { kind: 'aggregate', entry: join(fixtures, 'declarations.ts') },
    { kind: 'projection', entry: join(fixtures, 'declarations.ts'), names },
  ]);
  expect(selections).toHaveLength(8);
  expect(() => generateSchemaRegistryOutput(compiler.getTypeChecker(), navigateRegistries(compiler, selections))).not.toThrow();
});

test.each(['source', 'declarations'])('runtime Pick/Omit references fail prewrite and remain excludable with %s evidence', (mode) => {
  const compiler = mode === 'source' ? createProgramFromConfig(join(fixtures, 'nestedContracts.json')) : declarationProgram('nestedContracts');
  expect(ts.getPreEmitDiagnostics(compiler).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  const entry = join(fixtures, 'nestedContracts.ts');
  const eligible = [...moduleValues(compiler, entry)].filter(([, symbol]) =>
    classifyDefinition(compiler.getTypeChecker(), symbol)?.evidence.kind === 'projection').map(([name]) => name);
  const directory = mkdtempSync(join(fixtures, 'generated-reference-'));
  const spy = jest.spyOn(aggregateNavigator, 'createProgramFromConfig').mockReturnValue(compiler);
  try {
    for (const name of ['badRuntimePick', 'badRuntimeOmitPure', 'badRuntimeOmitState']) {
      const parent = join(directory, name);
      const outFile = join(parent, 'absent.ts');
      const options = { tsconfig: join(fixtures, 'nestedContracts.json'), outFile,
        discover: [{ kind: 'projection' as const, entry, exclude: eligible.filter((item) => item !== name), names: { [name]: name } }] };
      expect(() => extractSchemaRegistries(options)).toThrow(/required built member/);
      expect(existsSync(parent)).toBe(false);
      const existing = join(directory, `${name}.ts`);
      writeFileSync(existing, 'sentinel');
      expect(() => extractSchemaRegistries({ ...options, outFile: existing })).toThrow(/required built member/);
      expect(readFileSync(existing, 'utf8')).toBe('sentinel');
      extractSchemaRegistries({ ...options, outFile: existing, discover: [{ kind: 'projection', entry, exclude: eligible }] });
      expect(readFileSync(existing, 'utf8')).toContain('export const projectionSchemas');
    }
  } finally {
    spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
