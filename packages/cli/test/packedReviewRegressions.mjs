import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function reviewRegressions(consumer, command) {
  independentZod(command);
  const fixture = dependencyFixture(consumer);
  verifyDependency(consumer, fixture, command);
}

function independentZod(command) {
  console.log(command('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { z } from 'zod';
    import { z as independent } from 'independent-zod';
    import { Contract } from '@redemeine/kernel';
    import { describeContract } from '@redemeine/cli/reflector';
    assert.notEqual(z.ZodType, independent.ZodType);
    const schema = independent.object({ id: independent.string() });
    assert(schema instanceof z.ZodType);
    const contract = new Contract().addCommand('__proto__', schema).addEvent('do-work', schema).setStateSchema(schema);
    const result = describeContract(contract);
    assert.deepEqual(Object.keys(result.commands), ['__proto__']);
    assert.equal(Object.getPrototypeOf(result.commands), Object.prototype);
    assert.deepEqual(result.commands.__proto__, independent.toJSONSchema(schema));
    assert.deepEqual(result.events['do-work'], result.state);
    console.log('Independent Zod 4.3.6/4.4.3 constructors and JSON conversion PASS');
  `]));
}

function dependencyFixture(consumer) {
  const dependency = join(consumer, 'node_modules/review-schema-dependency');
  mkdirSync(dependency);
  writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'review-schema-dependency', type: 'module', exports: { '.': { types: './schema.d.ts', import: './schema.js' } } }));
  writeFileSync(join(dependency, 'schema.d.ts'), `import { z } from 'zod';
export declare const payloadSchema: z.ZodEnum<{ abc: 'abc'; xyz: 'xyz' }>;
export type Payload = z.infer<typeof payloadSchema>;
`);
  writeFileSync(join(dependency, 'schema.js'), `import { z } from 'zod'; export const payloadSchema = z.enum(['abc', 'xyz']);`);
  const fixture = join(consumer, 'review');
  mkdirSync(fixture);
  writeFileSync(join(fixture, 'aggregate.ts'), `import { createAggregate } from '@redemeine/aggregate';
import type { Payload } from 'review-schema-dependency';
import type { Event } from '@redemeine/kernel';
export const reviewed = createAggregate('reviewed', { accepted: false })
.events({ ['quote"key']: (state, event: Event<Payload>) => { state.accepted = !!event.payload; } })
.commands(emit => ({ ['do-work']: { pack: (payload: Payload) => payload, handler: (state: { accepted: boolean }, payload: Payload) => emit['quote"key'](payload) },
['__proto__']: { pack: (payload: Payload) => payload, handler: (state: { accepted: boolean }, payload: Payload) => emit['quote"key'](payload) } })).build();
`);
  writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true }, include: ['*.ts'] }));
  return fixture;
}

function verifyDependency(consumer, fixture, command) {
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'review/tsconfig.json']));
  console.log(command('node', ['--input-type=module', '-e', `
import { extractZodSchemas } from '@redemeine/cli/reflector';
extractZodSchemas({ tsconfig: 'review/tsconfig.json', entry: 'review/aggregate.ts', aggregateExport: 'reviewed', outFile: 'review/generated.ts' });
`]));
  const generated = readFileSync(join(fixture, 'generated.ts'), 'utf8');
  assert(!generated.includes(consumer));
  assert(!generated.includes('node_modules'));
  // TypeScript erases this z.infer alias; the legacy structural path must stay portable too.
  assert(generated.includes('z.enum(["abc", "xyz"])'));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'review/tsconfig.json']));
  console.log(command('node', ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync('review/generated.ts', 'utf8');
writeFileSync('review/generated.mjs', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { commandSchemas, eventSchemas } = await import('./review/generated.mjs');
assert.deepEqual(Object.keys(commandSchemas), ['do-work', '__proto__']);
assert.equal(Object.getPrototypeOf(commandSchemas), Object.prototype);
for (const schema of [...Object.values(commandSchemas), ...Object.values(eventSchemas)]) {
  assert(schema.safeParse('abc').success);
  assert(!schema.safeParse('x').success);
}
console.log('Packed dependency structural inlining and unusual keys PASS');
`]));
}
