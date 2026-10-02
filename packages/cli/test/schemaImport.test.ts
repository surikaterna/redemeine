import * as ts from 'typescript';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { existingSchemaImport } from '../src/extract/schemaImport';
import { TypeToZodConverter } from '../src/extract/typeConverter';
import { generateOutput } from '../src/extract/outputGenerator';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(__dirname, '.schema-import-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function query(program: ts.Program, source: string): ts.EntityName {
    const declaration = program.getSourceFile(source)!.statements.find(ts.isTypeAliasDeclaration)!;
    if (!ts.isTypeReferenceNode(declaration.type) || !declaration.type.typeArguments?.[0] || !ts.isTypeQueryNode(declaration.type.typeArguments[0])) throw Error('Missing query');
    return declaration.type.typeArguments[0].exprName;
}

function program(source: string): ts.Program {
    return ts.createProgram([source], { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
}

test('schema value aliases resolve to output-relative source imports, never CLI source paths', () => {
    writeFileSync(join(dir, 'schema.ts'), `import { z } from 'zod'; export const actual = z.object({ id: z.string() });`);
    const source = join(dir, 'input.ts');
    writeFileSync(source, `import { z } from 'zod'; import { actual as renamed } from './schema'; export type Payload = z.infer<typeof renamed>;`);
    const p = program(source);
    const result = existingSchemaImport(p.getTypeChecker(), p, query(p, source), join(dir, 'generated/output.ts'));
    expect(result.statement).toBe('import { "actual" as renamed } from "../schema";');
});

test('declaration dependency exports use their public package specifier', () => {
    const dependency = join(dir, 'node_modules/consumer-schema');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'consumer-schema', types: './internal.d.ts' }));
    writeFileSync(join(dependency, 'internal.d.ts'), `import { z } from 'zod'; export declare const actual: z.ZodString; export type Payload = z.infer<typeof actual>;`);
    const source = join(dir, 'input.ts');
    writeFileSync(source, `import { z } from 'zod'; import { actual as renamed } from 'consumer-schema'; export type Payload = z.infer<typeof renamed>;`);
    const p = program(source);
    expect(existingSchemaImport(p.getTypeChecker(), p, query(p, source)).statement).toBe('import { "actual" as renamed } from "consumer-schema";');
});

test('private inferred schema fails explicitly during conversion, before output is assembled', () => {
    const source = join(dir, 'input.ts');
    writeFileSync(source, `import { z } from 'zod'; const privateSchema = z.string(); export type Payload = z.infer<typeof privateSchema>;`);
    const p = program(source);
    const checker = p.getTypeChecker();
    const declaration = p.getSourceFile(source)!.statements.find(ts.isTypeAliasDeclaration)!;
    const aliasSymbol = checker.getSymbolAtLocation(declaration.name)!;
    // Exercise the named-alias branch even on TS versions which erase z.infer alias metadata.
    const type = new Proxy(checker.getTypeAtLocation(declaration), { get(target, key) {
        return key === 'aliasSymbol' ? aliasSymbol : Reflect.get(target, key);
    } });
    const converter = new TypeToZodConverter(checker, p, 'string', {}, join(dir, 'absent/output.ts'));
    expect(() => generateOutput(converter, new Map([['accept', type]]), new Map(), null, {})).toThrow('Cannot emit a portable import');
});

test('non-Zod generic typeof aliases are not misidentified as z.infer', () => {
    const source = join(dir, 'input.ts');
    writeFileSync(source, `type Other<T> = T; const privateValue = 'literal'; export type Payload = Other<typeof privateValue>;`);
    const p = program(source);
    const checker = p.getTypeChecker();
    const declaration = p.getSourceFile(source)!.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'Payload')!;
    expect(new TypeToZodConverter(checker, p).convert(checker.getTypeAtLocation(declaration))).toBe('z.literal("literal")');
});
