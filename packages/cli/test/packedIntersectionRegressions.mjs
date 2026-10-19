import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function intersectionRegressions(consumer, command, bin) {
  const directory = join(consumer, 'intersections');
  mkdirSync(directory);
  writeFileSync(join(directory, 'aggregate.ts'), `import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
/** A job to run after the payment outcome. */
type Job = {
  /** Queue job identifier. */
  jobId: string;
};
type Outcome = Job & { cancelJobIds: string[] };
type Failure = Outcome & { reason?: string };
type Register = Pick<Outcome, 'jobId'> & { confirmation: Job };
type Registered = Omit<Register, 'confirmation'> & Partial<Pick<Failure, 'reason'>>;
export const payment = createAggregate('payment', { job: { jobId: '' } })
.events({ failed: (_state, _event: Event<Failure>) => {} })
.commands(emit => ({
  register: (_state, _payload: Register) => [],
  restored: (_state, _payload: Registered) => [],
  fail: (_state, payload: Failure) => emit.failed(payload),
  noop: () => []
})).build();
type Branded = string & { brand: true };
export const unsupported = createAggregate('unsupported', {}).events({})
  .commands(() => ({ accept: (_state, _payload: Branded) => [] })).build();
throw new Error('DOMAIN_SOURCE_EXECUTED');
`);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    types: [], typeRoots: []
  }, files: ['aggregate.ts', 'generated.ts'] }));
  const generate = ['extract-schemas', '--entry', 'intersections/aggregate.ts', '--export', 'payment',
    '--tsconfig', 'intersections/tsconfig.json', '--out', 'intersections/generated.ts'];
  command(bin, generate);
  const output = readFileSync(join(directory, 'generated.ts'), 'utf8');
  command(bin, generate);
  assert.equal(readFileSync(join(directory, 'generated.ts'), 'utf8'), output);
  assert.match(output, /Source: aggregate\.ts — payment/);
  assert.match(output, /Queue job identifier/);
  assert.match(output, /\n\s+register: /);
  assert(!output.includes('z.any()'));
  command('npx', ['--no-install', 'tsc', '-p', 'intersections/tsconfig.json']);
  command('node', ['--input-type=module', '-e', `
import assert from 'node:assert/strict'; import ts from 'typescript'; import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('intersections/generated.mjs', ts.transpileModule(readFileSync('intersections/generated.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText);
const { commandSchemas: c, eventSchemas: e } = await import('./intersections/generated.mjs');
assert(c.register.safeParse({ jobId: 'a', confirmation: { jobId: 'b' } }).success);
assert(!c.register.safeParse({ jobId: 'a', confirmation: { jobId: 4 } }).success);
assert(c.restored.safeParse({ jobId: 'a' }).success);
assert(!c.restored.safeParse({ jobId: 'a', reason: 2 }).success);
assert(c.fail.safeParse({ jobId: 'a', cancelJobIds: [] }).success);
assert(!c.fail.safeParse({ jobId: 'a', cancelJobIds: [4] }).success);
assert.equal(c.fail, e.failed);
assert(c.noop.safeParse(undefined).success); assert(!c.noop.safeParse({}).success);
`]);
  const sentinel = join(directory, 'sentinel.ts');
  writeFileSync(sentinel, 'sentinel');
  const unsupported = ['extract-schemas', '--entry', 'intersections/aggregate.ts', '--export', 'unsupported',
    '--tsconfig', 'intersections/tsconfig.json'];
  const rejected = error => /Unsupported intersection/.test(`${error.stdout}${error.stderr}`);
  assert.throws(() => command(bin, [...unsupported, '--out', 'intersections/sentinel.ts']), rejected);
  assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel');
  assert.throws(() => command(bin, [...unsupported, '--out', 'intersections/absent/generated.ts']), rejected);
  assert(!existsSync(join(directory, 'absent')));
  console.log('Packed intersections, documentation, deterministic output and no-write failure PASS');
}
