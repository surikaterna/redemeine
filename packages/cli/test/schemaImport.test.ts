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

test.each([false, true])('import aliases and generated bindings share allocation (import first: %s)', importFirst => {
    const source = join(dir, 'input.ts');
    writeFileSync(source, `import { z } from 'zod'; export const actual = z.string();
        export type Payload = z.infer<typeof actual>;
        export type Second = z.infer<typeof actual>; export type Third = z.infer<typeof actual>;
        type _existing<T> = { id: T }; declare const values: [_existing<string>, _existing<number>];`);
    const p = program(source);
    expect(ts.getPreEmitDiagnostics(p)).toEqual([]);
    const checker = p.getTypeChecker();
    const declarations = p.getSourceFile(source)!.statements.filter(ts.isTypeAliasDeclaration);
    // TS erases z.infer metadata here; this Proxy exercises only the retained-alias branch.
    const inferred = declarations.slice(0, 3).map(declaration => new Proxy(checker.getTypeAtLocation(declaration), { get(target, key) {
        return key === 'aliasSymbol' ? checker.getSymbolAtLocation(declaration.name) : Reflect.get(target, key);
    } }));
    const variable = p.getSourceFile(source)!.statements.filter(ts.isVariableStatement)[1]!.declarationList.declarations[0]!;
    const structural = checker.getTypeArguments(checker.getTypeAtLocation(variable) as ts.TypeReference);
    const converter = new TypeToZodConverter(checker, p, 'string', {}, join(dir, 'output.ts'));
    const order = importFirst ? [...inferred, ...structural] : [...structural, ...inferred];
    const names = order.map(item => converter.convert(item));
    expect(new Set(names).size).toBe(5);
    expect(converter.convert(inferred[0]!)).toBe(names[importFirst ? 0 : 2]);
    const output = generateOutput(converter, new Map(order.map((type, index) => [String(index), type])), new Map(), null, {});
    writeFileSync(join(dir, 'output.ts'), output);
    expect(ts.getPreEmitDiagnostics(program(join(dir, 'output.ts')))).toEqual([]);
    const override = new TypeToZodConverter(checker, p, 'string', { Payload: 'z.number().min(1)' });
    override.convert(inferred[0]!);
    expect([...override.generatedShared.values()]).toEqual(['z.number().min(1)']);
    expect(override.imports.size).toBe(0);
});
