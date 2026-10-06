import * as ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TypeToZodConverter } from '../src/extract/typeConverter';
import { generateOutput } from '../src/extract/outputGenerator';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(__dirname, '.type-converter-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fixture() {
    writeFileSync(join(dir, 'a.ts'), 'export type Payload = { a: string };');
    writeFileSync(join(dir, 'b.ts'), 'export type Payload = { b: number };');
    const source = join(dir, 'input.ts');
    writeFileSync(source, `import type { Payload as A } from './a'; import type { Payload as B } from './b';
        type Foo = { upper: string }; type foo = { lower: number };
        type Box<T> = { value: T }; type State = { ready: boolean };
        type Z = { z: string }; type Command = { command: string }; type Event = { event: string };
        type Recursive = { next: Recursive };
        declare const values: [A, B, Foo, foo, Box<string>, Box<number>, State, Z, Command, Event, Recursive];`);
    const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: false, types: [] };
    const program = ts.createProgram([source], options);
    expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
    const checker = program.getTypeChecker();
    const declaration = program.getSourceFile(source)!.statements.filter(ts.isVariableStatement)[0]!.declarationList.declarations[0]!;
    const types = checker.getTypeArguments(checker.getTypeAtLocation(declaration) as ts.TypeReference);
    return { program, checker, types, options };
}

test('real compiler aliases, case collisions and generic instantiations retain independent schemas', () => {
    const { program, checker, types, options } = fixture();
    expect(types[0]!.aliasSymbol).not.toBe(types[1]!.aliasSymbol);
    expect(types[4]!.aliasSymbol).toBe(types[5]!.aliasSymbol);
    expect(types[4]).not.toBe(types[5]);
    const converter = new TypeToZodConverter(checker, program);
    const commands = new Map(types.slice(0, 6).map((type, index) => [`case${index}`, type]));
    commands.set('repeat', types[0]!);
    const output = generateOutput(converter, commands, new Map([['second', types[1]!]]), types[6]!, {});
    expect(new Set(types.slice(0, 7).map(type => converter.convert(type))).size).toBe(7);
    expect(converter.generatedShared.size).toBe(7);
    const generated = join(dir, 'generated.ts');
    writeFileSync(generated, output);
    expect(ts.getPreEmitDiagnostics(ts.createProgram([generated], options))).toEqual([]);
    const schemas = new Function('z', `${output.replace(/import[^\n]+\n/g, '').replace(/export /g, '').replace(/ as const/g, '')}; return { commandSchemas, eventSchemas, stateSchema };`)(z) as {
        commandSchemas: Record<string, z.ZodType>; eventSchemas: Record<string, z.ZodType>; stateSchema: z.ZodType;
    };
    const good = [{ a: 'a' }, { b: 1 }, { upper: 'u' }, { lower: 2 }, { value: 's' }, { value: 3 }];
    const bad = [{ b: 1 }, { a: 'a' }, { lower: 2 }, { upper: 'u' }, { value: 3 }, { value: 's' }];
    good.forEach((value, index) => {
        expect(schemas.commandSchemas[`case${index}`]!.safeParse(value).success).toBe(true);
        expect(schemas.commandSchemas[`case${index}`]!.safeParse(bad[index]).success).toBe(false);
    });
    expect(schemas.commandSchemas.repeat).toBe(schemas.commandSchemas.case0);
    expect(schemas.eventSchemas.second).toBe(schemas.commandSchemas.case1);
    expect(schemas.stateSchema.safeParse({ ready: true }).success).toBe(true);
    expect(schemas.stateSchema.safeParse({ ready: 'yes' }).success).toBe(false);
});

test('name overrides remain authoritative expressions across distinct same-name aliases', () => {
    const { program, checker, types } = fixture();
    const expression = 'z.string().transform(value => ({ value }))';
    const converter = new TypeToZodConverter(checker, program, 'string', { Payload: expression });
    expect(converter.convert(types[0]!)).toBe(converter.convert(types[1]!));
    expect([...converter.generatedShared.values()]).toEqual([expression]);
});

test('recursive conversion remains bounded and caches only completed conversions', () => {
    const { program, checker, types } = fixture();
    const converter = new TypeToZodConverter(checker, program);
    const name = converter.convert(types[10]!);
    expect(converter.convert(types[10]!)).toBe(name);
    expect(converter.convert(types[10]!, 11)).toBe('z.any()');
    expect([...converter.generatedShared.values()].join('\n')).toContain('z.any()');
    expect(converter.generatedShared.get(name)).not.toContain(`: ${name}`);
});
