import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as ts from 'typescript';

function compile(files: Map<string, string>, entry: string, options: ts.CompilerOptions, emit: boolean) {
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = file => files.get(file) ?? readFile(file);
  host.fileExists = file => files.has(file) || fileExists(file);
  host.writeFile = (file, text) => { files.set(file, text); };
  const program = ts.createProgram([entry], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (emit) diagnostics.push(...program.emit().diagnostics);
  return { program, diagnostics: diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) };
}

test.each(['ts', 'mts', 'cts'])('%s inherited mounts emit and recompile strict declarations', suffix => {
  const entry = join(__dirname, `inheritedMountConsumer.${suffix}`);
  const fixture = readFileSync(join(__dirname, 'inheritedMounts.fixture.ts.txt'), 'utf8');
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

test.each(['module', 'commonjs'])('%s public runtime invokes inherited mounted creators', format => {
  const load = format === 'module'
    ? "import { createAggregate, createEntity } from '@redemeine/aggregate';"
    : "const { createAggregate, createEntity } = require('@redemeine/aggregate');";
  const result = spawnSync(process.execPath, [`--input-type=${format}`, '-e', `${load}
    const item = createEntity('item').events({ changed(draft, event) { draft.count += event.payload.amount; } })
      .commands(emit => ({ change: { pack: payload => payload, handler: (_state, payload) => emit.changed(payload) } })).build();
    const state = { rows: [{ id: 'one', count: 0 }] };
    const parent = createAggregate('parent', state).entityList('rows', item);
    const child = createAggregate('child', state).extends(parent).build();
    const events = child.process(state, child.commandCreators.rowsChange({ id: 'one', amount: 2 }));
    if (events.length !== 1 || child.apply(state, events[0]).rows[0].count !== 2) throw Error('inherited routing failed');
    if (child.mounts.rows.entity !== item) throw Error('component identity lost');
  `], { cwd: join(__dirname, '..'), encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
