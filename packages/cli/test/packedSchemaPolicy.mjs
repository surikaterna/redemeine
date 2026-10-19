import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function schemaPolicyRegressions(consumer, command, bin) {
  const directory = join(consumer, 'schema-policy');
  mkdirSync(directory);
  const configure = schemas => writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, redemeine: { schemas } }));
  configure(undefined);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [], typeRoots: []
  }, include: ['*.ts'] }));
  writeFileSync(join(directory, 'schemas.ts'), `import { z } from 'zod';
    export const identifier = z.string().min(3); export type Identifier = z.infer<typeof identifier>;
    export const state = z.object({ id: identifier }); export type State = z.infer<typeof state>;
    export const changed = z.object({ id: identifier }); export type Changed = z.infer<typeof changed>;`);
  writeFileSync(join(directory, 'input.ts'), `import { createAggregate } from '@redemeine/aggregate';
    import type { Event } from '@redemeine/kernel'; import type { Identifier, State, Changed } from './schemas';
    export const linked = createAggregate<State, 'linked'>('linked', { id: 'old' })
      .events({ changed: (state, event: Event<Changed>) => { state.id = event.payload.id; } })
      .commands(emit => ({ change: (_state, id: Identifier) => emit.changed({ id }) })).build();
    export const gradual = createAggregate<State, 'gradual'>('gradual', { id: 'old' })
      .events({ changed: (_state, _event: Event<Changed>) => {} })
      .commands(() => ({ checked: (_state, id: Identifier) => [], plain: (_state, text: string) => [] })).build();
    export const deep = createAggregate('deep', { value: { nested: { id: '' } } }).events({}).commands(() => ({})).build();
    throw new Error('DOMAIN_EXECUTED');`);
  const generate = name => [bin, 'extract-schemas', '--entry', 'schema-policy/input.ts', '--export', name,
    '--tsconfig', 'schema-policy/tsconfig.json', '--out', 'schema-policy/generated.ts'];
  command(process.execPath, generate('linked'));
  const linked = readFileSync(join(directory, 'generated.ts'), 'utf8');
  assert.match(linked, /from "\.\/schemas"/);
  assert(!linked.includes('z.object('));
  command(process.execPath, generate('linked'));
  assert.equal(readFileSync(join(directory, 'generated.ts'), 'utf8'), linked);
  assert.throws(() => command(process.execPath, generate('gradual')),
    error => /no importable Zod schema/.test(`${error.stdout}${error.stderr}`));
  assert.equal(readFileSync(join(directory, 'generated.ts'), 'utf8'), linked);
  configure({ mode: 'types-first', maxDepth: 1 });
  command(process.execPath, generate('gradual'));
  command('npx', ['--no-install', 'tsc', '-p', 'schema-policy/tsconfig.json']);
  command('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import ts from 'typescript'; import { readFileSync, writeFileSync } from 'node:fs';
    import { createRequire } from 'node:module';
    for (const name of ['schemas', 'generated']) writeFileSync('schema-policy/' + name + '.js', ts.transpileModule(
      readFileSync('schema-policy/' + name + '.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
    const { commandSchemas: c } = createRequire(import.meta.url)('./schema-policy/generated.js');
    assert(c.checked.safeParse('abc').success); assert(!c.checked.safeParse('x').success); assert(c.plain.safeParse('x').success);
  `]);
  const before = readFileSync(join(directory, 'generated.ts'), 'utf8');
  assert.throws(() => command(process.execPath, generate('deep')), error => /maxDepth \(1\)/.test(`${error.stdout}${error.stderr}`));
  assert.equal(readFileSync(join(directory, 'generated.ts'), 'utf8'), before);
  configure({ mode: 'types-first', maxDepth: 6 });
  command(process.execPath, generate('deep'));
  const existing = readFileSync(join(directory, 'schemas.ts'), 'utf8');
  writeFileSync(join(directory, 'schemas.ts'), existing.replace('export const identifier', 'const identifier'));
  assert.throws(() => command(process.execPath, generate('linked')), error => /portable import/.test(`${error.stdout}${error.stderr}`));
  writeFileSync(join(directory, 'schemas.ts'), existing);
  provenanceDepthChecks(directory, configure, command, bin);
  console.log('Packed package schema policy, linked refinements, gradual migration, depth and export checks PASS');
}

function provenanceDepthChecks(directory, configure, command, bin) {
  const fields = Array.from({ length: 160 }, (_, index) => `field${index}: string;`).join('\n');
  const aliases = Array.from({ length: 48 }, (_, index) => `type Link${index} = ${index === 47 ? '{ value: string }' : `Link${index + 1}`};`).join('\n');
  writeFileSync(join(directory, 'provenance.ts'), `import { createAggregate } from '@redemeine/aggregate';
    interface Wide { ${fields} } ${aliases}
    export const wide = createAggregate<Wide, 'wide'>('wide', {} as Wide).events({}).commands(() => ({})).build();
    export const deepAliases = createAggregate<Link0, 'aliases'>('aliases', {} as Link0).events({}).commands(() => ({})).build();
    throw new Error('DOMAIN_EXECUTED');`);
  const args = name => [bin, 'extract-schemas', '--entry', 'schema-policy/provenance.ts', '--export', name,
    '--tsconfig', 'schema-policy/tsconfig.json', '--out', 'schema-policy/generated.ts'];
  configure({ mode: 'types-first', maxDepth: 4, maxProvenanceDepth: 32 });
  command(process.execPath, args('wide'));
  const wide = readFileSync(join(directory, 'generated.ts'), 'utf8');
  assert.match(wide, /field159/);
  assert.match(wide, /maxProvenanceDepth: 32/);
  assert.throws(() => command(process.execPath, args('deepAliases')),
    error => /maxProvenanceDepth \(32\)/.test(`${error.stdout}${error.stderr}`));
  assert.equal(readFileSync(join(directory, 'generated.ts'), 'utf8'), wide);
  configure({ mode: 'types-first', maxDepth: 4, maxProvenanceDepth: 128 });
  command(process.execPath, args('deepAliases'));
  assert.match(readFileSync(join(directory, 'generated.ts'), 'utf8'), /value: z.string/);
  command('npx', ['--no-install', 'tsc', '-p', 'schema-policy/tsconfig.json']);
  console.log('Packed wide/deep provenance and package override checks PASS');
}
