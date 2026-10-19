import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { extractZodSchemas } from '../src/extractZodSchemas';
import { extractProjectionSchemas } from '../src/extractProjectionSchemas';
import { extractSchemaRegistries } from '../src/extractSchemaRegistries';
import { validateSchemaPolicy } from '../src/extract/schemaConfig';
import { searchProvenance, syntaxChildren } from '../src/extract/provenanceTraversal';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(__dirname, '.provenance-depth-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

type Kind = 'aggregate' | 'aggregate-json' | 'projection' | 'projection-json' | 'registry';
const kinds: Kind[] = ['aggregate', 'aggregate-json', 'projection', 'projection-json', 'registry'];

function configure(schemas: object) {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, redemeine: { schemas } }));
}

function fixture(declarations: string, schemas: object = { mode: 'types-first' }) {
    configure(schemas);
    const source = `import { createAggregate } from '@redemeine/aggregate';
        import { createProjection } from '@redemeine/projection';
        ${declarations}
        export const aggregate = createAggregate<Payload, 'example'>('example', {} as Payload).events({})
          .commands(() => ({ accept: (_state, value: Payload) => [] })).build();
        export const view = createProjection('exampleView', (): Payload => ({} as Payload)).from(aggregate, {}).build();
        throw new Error('APPLICATION_EXECUTED');`;
    const options = { entry: join(directory, 'input.ts'), tsconfig: join(directory, 'tsconfig.json'), outFile: join(directory, 'output.ts') };
    writeFileSync(options.entry, source);
    writeFileSync(options.tsconfig, JSON.stringify({ compilerOptions: {
        strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [], esModuleInterop: true,
        paths: { '@redemeine/aggregate': [join(__dirname, '../../aggregate/dist/index.d.ts')],
            '@redemeine/projection': [join(__dirname, '../../projection/dist/index.d.ts')] }
    }, include: ['*.ts'] }));
    const config = ts.readConfigFile(options.tsconfig, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
    expect(ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))).toEqual([]);
    return options;
}

function extract(kind: Kind, options: ReturnType<typeof fixture>) {
    if (kind === 'registry') return extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: options.outFile, definitions: [
        { kind: 'aggregate', entry: options.entry, export: 'aggregate' },
        { kind: 'projection', entry: options.entry, export: 'view', name: 'exampleView' }
    ] });
    const format = kind.endsWith('json') ? 'json-schema' : 'zod';
    if (kind.startsWith('projection')) return extractProjectionSchemas({ ...options, projectionExport: 'view', format });
    return extractZodSchemas({ ...options, aggregateExport: 'aggregate', format });
}

function aliases(length: number) {
    return Array.from({ length }, (_, index) => `type Link${index} = ${index === length - 1 ? '{ value: string }' : `Link${index + 1}`};`).join('\n')
        + '\ntype Payload = Link0;';
}

test.each(kinds)('%s accepts wide shallow declarations beyond 256 syntax nodes', kind => {
    const fields = Array.from({ length: 160 }, (_, index) => `field${index}: string;`).join('\n');
    const options = fixture(`interface Wide { ${fields} } type Payload = Pick<Wide, keyof Wide>;`, { mode: 'types-first', maxProvenanceDepth: 32 });
    const syntax = ts.createSourceFile('wide.ts', `interface Wide { ${fields} }`, ts.ScriptTarget.Latest, true);
    let count = 0;
    searchProvenance([syntax], node => { count++; return { children: syntaxChildren(node) }; }, 32);
    expect(count).toBeGreaterThan(256);
    extract(kind, options);
    const output = readFileSync(options.outFile, 'utf8');
    expect(output).toContain('field159');
    expect(output).not.toContain('z.any()');
    extract(kind, options);
    expect(readFileSync(options.outFile, 'utf8')).toBe(output);
});

test.each(kinds)('%s applies owning-package provenance depth separately from structural depth', kind => {
    const options = fixture(aliases(48), { mode: 'types-first', maxDepth: 4, maxProvenanceDepth: 32 });
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extract(kind, options)).toThrow(/maxProvenanceDepth \(32\)/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    configure({ mode: 'types-first', maxDepth: 4, maxProvenanceDepth: 128 });
    extract(kind, options);
    expect(readFileSync(options.outFile, 'utf8')).toContain('value');
});

test('the default is 256 steps and an explicit override can allow longer alias paths', () => {
    const options = fixture(aliases(300));
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extract('aggregate', options)).toThrow(/maxProvenanceDepth \(256\)/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    configure({ mode: 'types-first', maxProvenanceDepth: 512 });
    extract('aggregate', options);
    expect(readFileSync(options.outFile, 'utf8')).toContain('z.string()');
});

test.each(['aggregate', 'projection', 'registry'] as Kind[])('%s applies provenance overrides to authored schema linking in zod-first mode', kind => {
    writeFileSync(join(directory, 'schemas.ts'), `import { z } from 'zod';
        export const state = z.object({ value: z.string().min(3) }); export type State = z.infer<typeof state>;`);
    const chain = Array.from({ length: 48 }, (_, index) => `type Link${index} = ${index === 47 ? 'State' : `Link${index + 1}`};`).join('\n');
    const options = fixture(`import type { State } from './schemas'; ${chain} type Payload = Link0;`, { maxProvenanceDepth: 32 });
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extract(kind, options)).toThrow(/maxProvenanceDepth \(32\)/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    configure({ maxProvenanceDepth: 128 });
    extract(kind, options);
    const output = readFileSync(options.outFile, 'utf8');
    expect(output).toContain('from "./schemas"');
    expect(output).not.toContain('z.object(');
});

test('registry aliases retain the provenance limit of each owning entry package', () => {
    const options = fixture(aliases(48), { mode: 'types-first', maxProvenanceDepth: 128 });
    const child = join(directory, 'child');
    mkdirSync(child);
    writeFileSync(join(child, 'package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'types-first', maxProvenanceDepth: 32 } } }));
    writeFileSync(join(child, 'alias.ts'), `export { aggregate } from '../input';`);
    const config = JSON.parse(readFileSync(options.tsconfig, 'utf8'));
    config.include = ['**/*.ts'];
    writeFileSync(options.tsconfig, JSON.stringify(config));
    writeFileSync(options.outFile, 'sentinel');
    const generate = () => extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: options.outFile, definitions: [
        { kind: 'aggregate', entry: options.entry, export: 'aggregate' }
    ], discover: [{ kind: 'aggregate', entry: join(child, 'alias.ts') }] });
    expect(generate).toThrow(/maxProvenanceDepth \(32\)/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    writeFileSync(join(child, 'package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'types-first', maxProvenanceDepth: 128 } } }));
    expect(generate).not.toThrow();
});

test('the iterative traversal terminates cycles and bounds deep unresolved paths', () => {
    const nodes = Array.from({ length: 1100 }, (_, index) => ts.factory.createIdentifier(`node${index}`));
    const next = new Map(nodes.map((node, index) => [node, nodes[index + 1] ?? nodes[0]!]));
    expect(() => searchProvenance([nodes[0]!], node => ({ children: [next.get(node as ts.Identifier)!] }), 1024))
        .toThrow(/maxProvenanceDepth \(1024\)/);
    let visits = 0;
    searchProvenance(nodes.slice(0, 3), node => {
        visits++;
        return { children: [nodes[(nodes.indexOf(node as ts.Identifier) + 1) % 3]!] };
    }, 3);
    expect(visits).toBe(3);
});

test.each([0, -1, 1.5, 1025, '256', null])('invalid maxProvenanceDepth %j is rejected', maxProvenanceDepth => {
    expect(() => validateSchemaPolicy({ maxProvenanceDepth })).toThrow(/maxProvenanceDepth/);
});

test('wide graphs still discover late authored schemas and refuse lossy JSON', () => {
    writeFileSync(join(directory, 'schemas.ts'), `import { z } from 'zod'; export const id = z.string().min(3); export type Id = z.infer<typeof id>;`);
    const fields = Array.from({ length: 160 }, (_, index) => `field${index}: string;`).join('\n');
    const options = fixture(`import type { Id } from './schemas'; interface Payload { ${fields} checked: Id }`);
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extract('aggregate-json', options)).toThrow(/existing Zod schema/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    extract('aggregate', options);
    expect(readFileSync(options.outFile, 'utf8')).toContain('from "./schemas"');
});

test('cycles terminate without hiding authored schemas on a later branch', () => {
    writeFileSync(join(directory, 'schemas.ts'), `import { z } from 'zod'; export const id = z.string().min(3); export type Id = z.infer<typeof id>;`);
    const options = fixture(`import type { Id } from './schemas'; interface Payload { next?: Payload; id: Id }`);
    expect(() => extract('aggregate-json', options)).toThrow(/existing Zod schema/);
    expect(() => extract('aggregate', options)).toThrow(/recursive/);
});
