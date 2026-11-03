import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function registryCommandRegressions(consumer, command, bin) {
  const directory = join(consumer, 'registry-commands');
  mkdirSync(directory);
  const fixture = readFileSync(new URL('./fixtures/registryCommands.ts', import.meta.url), 'utf8');
  writeFileSync(join(directory, 'input.mts'), fixture);
  writeFileSync(join(directory, 'input.cts'), fixture);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [],
    declaration: true, emitDeclarationOnly: true, outDir: './public',
  }, files: ['./input.mts', './input.cts'] }));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'registry-commands/tsconfig.json']));
  writeFileSync(join(directory, 'extract.json'), JSON.stringify({ compilerOptions: {
    strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [],
  }, include: ['./*.mts', './*.cts', './public/*'] }));
  for (const entry of ['input.mts', 'input.cts', 'public/input.d.mts', 'public/input.d.cts']) {
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ version: 1, tsconfig: './extract.json',
      discover: [{ kind: 'aggregate', entry: `./${entry}` }] }));
    console.log(command(bin, ['extract-schema-registries', '--manifest', 'registry-commands/manifest.json',
      '--out', 'registry-commands/generated.ts']));
    const output = readFileSync(join(directory, 'generated.ts'), 'utf8');
    assert(output.includes('lineChange') && output.includes('noteChange'));
    console.log(command('node', ['--input-type=module', '-e', check]));
  }
}

const check = `import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
const text = readFileSync('registry-commands/generated.ts', 'utf8');
writeFileSync('registry-commands/generated.mjs', ts.transpileModule(text, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
} }).outputText);
const { aggregateSchemas, aggregateJsonSchemas } = await import('./registry-commands/generated.mjs');
const schemas = aggregateSchemas.get('registryCommands');
const json = aggregateJsonSchemas.get('registryCommands');
assert(schemas.state.safeParse({ count: 1, line: [], note: {} }).success);
assert(!schemas.state.safeParse({ count: 'wrong', line: [], note: {} }).success);
assert.equal(json.state.properties.count.type, 'number');
assert.deepEqual(Object.keys(schemas.commands).sort(), ['accept', 'lineChange', 'noteChange']);
assert.deepEqual(Object.keys(schemas.events), ['accepted']);
assert.deepEqual(Object.keys(json.events), ['accepted']);
for (const key of ['lineChange', 'noteChange']) {
  const schema = schemas.commands[key];
  assert(schema.safeParse({ id: 'child', value: 'trimmed' }).success);
  for (const wrong of [{ raw: 'pack input' }, { id: 1, value: 'bad' }, { id: 'child' }]) {
    assert(!schema.safeParse(wrong).success);
  }
  assert.equal(json.commands[key].type, 'object');
  assert.deepEqual(json.commands[key].required, ['id', 'value']);
  assert.equal(json.commands[key].properties.id.type, 'string');
  assert.equal(json.commands[key].properties.value.type, 'string');
}
console.log('Packed source/public ESM/CJS registry commands: canonical output Zod/JSON and root-only events PASS');`;
