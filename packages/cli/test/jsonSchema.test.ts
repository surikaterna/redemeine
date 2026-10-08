import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSchemasCommand } from '../src/extractSchemasCommand';
import { extractZodSchemas } from '../src/extractZodSchemas';

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); jest.restoreAllMocks(); });

function fixture(payload: string, declarations = '', state = '{ total: number }') {
  const directory = mkdtempSync(join(__dirname, '.json-schema-'));
  directories.push(directory);
  const entry = join(directory, 'input.ts');
  const tsconfig = join(directory, 'tsconfig.json');
  const out = join(directory, 'output.json');
  writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] }));
  writeFileSync(entry, `${declarations}
    type Payload = ${payload}; type State = ${state};
    declare const aggregate: {
      commandCreators: { save(payload: Payload): { payload: Payload }; confirm(): { payload: void }; expire(): { payload: undefined }; impossible(): { payload: never } };
      pure: { eventProjectors: { saved(state: State, event: { payload: Payload }): void } };
      initialState: State;
    };
    export { aggregate };
    export const view = { name: 'view', fromStream: 'events', identity: {}, subscriptions: [], initialState: (): State => { throw Error('factory executed'); } };
    throw Error('source executed');
  `);
  const extract = (options: Record<string, string | boolean> = {}) => extractSchemasCommand({ entry, tsconfig, out, export: 'aggregate', format: 'json-schema', ...options });
  return { entry, tsconfig, out, directory, extract, read: () => JSON.parse(readFileSync(out, 'utf8')) };
}

test.each(['draft-7', 'draft-2020-12'])('aggregate structural JSON %s retains intersections, optional/null and underscore fields', target => {
  const f = fixture('Pick<Base, "id"> & Partial<Omit<Base, "id">> & { money: Money; entries: ReadonlyArray<{ key: string }>; extra: Record<string, number>; _internal: boolean }', `
    type Base = { id: string; optional: string | null }; class Money { amount!: number; currency!: { name: 'EUR' | 'GBP' } }
  `);
  f.extract({ target });
  const output = f.read();
  expect(Object.keys(output.commands)).toEqual(['confirm', 'expire', 'impossible', 'save']);
  expect(output.commands.confirm).toBe(false);
  expect(output.commands.expire).toBe(false);
  expect(output.commands.impossible).toBe(false);
  expect(output.commands.save.$schema).toContain(target === 'draft-7' ? 'draft-07' : '2020-12');
  expect(output.commands.save.required).toEqual(['_internal', 'entries', 'extra', 'id', 'money']);
  expect(output.commands.save.properties.optional.anyOf).toContainEqual({ type: 'null' });
  expect(output.commands.save.properties.money.properties.amount).toEqual({ type: 'number' });
  expect(output.commands.save.properties.entries.items.properties.key).toEqual({ type: 'string' });
  expect(output.commands.save.properties.extra.additionalProperties).toEqual({ type: 'number' });
  expect(output.commands.save).not.toHaveProperty('additionalProperties');
  const bytes = readFileSync(f.out, 'utf8');
  f.extract({ target });
  expect(readFileSync(f.out, 'utf8')).toBe(bytes);
  f.extract({ 'no-state': true });
  expect(f.read()).not.toHaveProperty('state');
});

test('JSON defaults to 2020-12 and projection emits direct state, not a bundle', () => {
  const f = fixture('string', '', '{ _id: string; optional?: string; nullable: string | null }');
  f.extract({ kind: 'projection', export: 'view' });
  expect(f.read()).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['_id', 'nullable'] });
  expect(f.read()).not.toHaveProperty('commands');
  f.extract({ kind: 'projection', export: 'view', target: 'draft-7' });
  expect(f.read().$schema).toBe('http://json-schema.org/draft-07/schema#');
});

test.each(['aggregate', 'projection'])('default and explicit Zod remain identical for %s', kind => {
  const f = fixture('{ id: string }');
  const options = { kind, export: kind === 'aggregate' ? 'aggregate' : 'view', format: 'zod' };
  extractSchemasCommand({ entry: f.entry, tsconfig: f.tsconfig, out: f.out, kind, export: options.export });
  const before = readFileSync(f.out, 'utf8');
  f.extract(options);
  expect(readFileSync(f.out, 'utf8')).toBe(before);
  expect(before).toContain('export const stateSchema');
  expect(before).toContain(kind === 'projection' ? 'stateJsonSchema' : 'commandSchemas');
});

test('explicit any/unknown are diagnosed, including array and string-index values', () => {
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const f = fixture('{ arbitrary: any; opaque: unknown; list: any[]; record: Record<string, unknown>; absent: undefined; maybe?: undefined }');
  f.extract();
  const schema = f.read().commands.save;
  expect(schema.properties.arbitrary).toBe(true);
  expect(schema.properties.opaque).toBe(true);
  expect(schema.properties.list.items).toBe(true);
  expect(schema.properties.record.additionalProperties).toBe(true);
  expect(schema.properties.absent).toBe(false);
  expect(schema.properties.maybe).toBe(false);
  expect(schema.required).toContain('absent');
  expect(schema.required).not.toContain('maybe');
  expect(warning.mock.calls.some(([text]) => text.includes('aggregate.commands["save"]["arbitrary"]'))).toBe(true);
});

test.each(['any', 'unknown'])('declaration-proven standalone %s is true, not an unresolved fallback', type => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const f = fixture(type);
  f.extract();
  expect(f.read().commands.save).toBe(true);
});

test.each([
  ['{ valid: string; late: Missing }', '', /late.*Cannot find name/],
  ['{ late: Missing }', 'import type { Missing } from "absent-package";', /late.*unresolved/],
  ['{ late: any | Missing }', 'import type { Missing } from "absent-package";', /late.*unresolved/],
  ['{ late: Omit<Missing, "id"> }', 'import type { Missing } from "absent-package";', /late.*unresolved/],
  ['{ late: any | Missing }', '', /late.*Cannot find name/],
  ['{ late }', '', /late.*implicitly/],
  ['{ late: () => void }', '', /late.*functions/],
  ['{ late: Bad }', 'class Bad { method() {} }', /method.*functions/],
  ['{ late: Bad }', 'class Bad { private value!: string }', /value.*public data/],
  ['{ late: Bad }', 'class Bad { get value(): string { return "x" } }', /value.*public data/],
  ['{ late: [string, number] }', '', /late.*tuples/],
  ['{ late: A }', 'type A = { next: A };', /next.*recursive/],
  ['{ late: A }', 'interface A extends Missing { id: string }', /late.*Cannot find name 'Missing'/],
  ['{ id: string } & { id: number }', '', /id.*conflicting/],
  ['Record<string, string> & { id: number }', '', /id.*string-index constraint/],
  ['string & { brand: true }', '', /structural object intersections/],
])('failure is path-qualified and atomic: %s', (payload, declarations, message) => {
  const f = fixture(payload as string, declarations as string);
  writeFileSync(f.out, 'sentinel');
  expect(() => f.extract()).toThrow(message as RegExp);
  expect(readFileSync(f.out, 'utf8')).toBe('sentinel');
  const missing = join(f.directory, 'new-directory/output.json');
  expect(() => f.extract({ out: missing })).toThrow(message as RegExp);
  expect(existsSync(join(f.directory, 'new-directory'))).toBe(false);
});

test('depth cutoff fails rather than widening', () => {
  const aliases = Array.from({ length: 65 }, (_, i) => `type N${i} = { next: ${i === 64 ? 'string' : `N${i + 1}`} };`).join('\n');
  const f = fixture('N0', aliases);
  expect(() => f.extract()).toThrow(/aggregate.commands.*depth/);
  expect(existsSync(f.out)).toBe(false);
});

test.each([
  ['inheritance', 'interface A { x: string } interface B { x: number } export interface P extends A, B {}', '', /cannot simultaneously extend/],
  ['override', 'interface A { x: string } export interface P extends A { x: number }', '', /incorrectly extends/],
  ['merge', 'export interface P { x: string }', 'import "./model"; declare module "./model" { interface P { x: number } }', /Subsequent property declarations/],
])('rejects recovered %s declarations, including imported .d.ts, without writes', (_name, model, augmentation, reason) => {
  const f = fixture('{ late: P }', 'import type { P } from "./model";');
  for (const extension of ['ts', 'd.ts']) {
    const files = [join(f.directory, `model.${extension}`), join(f.directory, `augmentation.${extension}`)];
    writeFileSync(files[0]!, model as string);
    writeFileSync(files[1]!, augmentation as string);
    writeFileSync(f.out, 'sentinel');
    const failure = new RegExp(`aggregate\\.commands\\["save"\\]\\["late"\\].*${(reason as RegExp).source}`, 's');
    expect(() => f.extract()).toThrow(failure);
    expect(readFileSync(f.out, 'utf8')).toBe('sentinel');
    expect(() => f.extract({ out: join(f.directory, 'absent/out.json') })).toThrow(failure);
    expect(existsSync(join(f.directory, 'absent'))).toBe(false);
    files.forEach(file => rmSync(file));
  }
});

test('valid inheritance/merging/intersections ignore unrelated diagnostics and constructor bodies', () => {
  const f = fixture('{ late: P & { tag: boolean }; data: Data }', `import type { P } from './model';
    class Data { x: string; constructor() { const unrelated: number = 'bad'; this.x = 'ok'; } }`);
  writeFileSync(join(f.directory, 'model.ts'), `interface A { x: string } export interface P extends A { x: 'ok' }
    export interface P { amount: number } interface Unrelated extends A { x: number }
    const unrelatedApplication: string = 123;`);
  f.extract();
  expect(f.read().commands.save.properties.late.properties).toMatchObject({ amount: { type: 'number' }, x: { type: 'string', const: 'ok' } });
  expect(f.read().commands.save.properties.late.properties.tag).toBeDefined();
  expect(f.read().commands.save.properties.data.properties.x).toEqual({ type: 'string' });
});

test('Pick cannot hide a contradictory inherited data declaration behind recovered properties', () => {
  const f = fixture('{ late: Pick<Derived, "x"> }', 'import type { Derived } from "./model";');
  writeFileSync(join(f.directory, 'model.d.ts'), `interface A { x: string } interface B { x: number }
    interface P extends A, B {} export interface Derived extends P {}`);
  writeFileSync(f.out, 'sentinel');
  expect(() => f.extract()).toThrow(/aggregate\.commands\["save"\]\["late"\].*cannot simultaneously extend/s);
  expect(readFileSync(f.out, 'utf8')).toBe('sentinel');
});

test('checks annotations on later merged properties, not just the recovered first declaration', () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const f = fixture('{ late: P }', 'import type { P } from "./model";');
  writeFileSync(join(f.directory, 'model.ts'), 'export interface P { x: any }');
  writeFileSync(join(f.directory, 'augmentation.ts'), `import './model'; import type { Missing } from 'absent-package';
    declare module './model' { interface P { x: any | Missing } }`);
  writeFileSync(f.out, 'sentinel');
  expect(() => f.extract()).toThrow(/aggregate\.commands\["save"\]\["late"\]\["x"\].*unresolved/);
  expect(readFileSync(f.out, 'utf8')).toBe('sentinel');
});

test.each(['{ value: any }', '{ value: unknown }', '{ value: void }', '{ value: undefined }', '{ x: string } & { y: number }', '{}'])(
  'projection JSON retains strict rejection of %s', state => {
    const f = fixture('string', '', state);
    expect(() => f.extract({ kind: 'projection', export: 'view' })).toThrow('view.initialState');
    expect(existsSync(f.out)).toBe(false);
  },
);

test.each([
  { format: 'invalid' }, { format: 'zod', target: 'draft-7' }, { target: 'invalid' },
  { 'date-handling': 'date' }, { kind: 'projection', 'no-state': true }, { kind: 'projection', 'date-handling': 'string' },
])('invalid flags fail before writes: %j', options => {
  const f = fixture('string');
  expect(() => f.extract(options)).toThrow();
  expect(existsSync(f.out)).toBe(false);
});

test('JSON refuses code-string overrides without evaluating them', () => {
  const f = fixture('string');
  expect(() => extractZodSchemas({ ...f, aggregateExport: 'aggregate', outFile: f.out, format: 'json-schema', typeOverrides: { Payload: 'throw Error("executed")' } })).toThrow('typeOverrides');
  expect(existsSync(f.out)).toBe(false);
});

test('imported z.infer is structural only and its side effects never execute', () => {
  const f = fixture('Inferred', 'import type { Inferred } from "./schema";');
  writeFileSync(join(f.directory, 'schema.ts'), `import { z } from 'zod'; export const schema = z.string().min(8); export type Inferred = z.infer<typeof schema>; throw Error('import executed');`);
  f.extract();
  expect(f.read().commands.save).toEqual({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' });
});
